import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
import { z } from "zod";
// Type-only: brings the `config.cliAuth` augmentation into every program that
// type-checks this file (the frontend reaches it through the CLI actions).
import type {} from "../config/cliAuth";
import { type CliToken, cliTokens } from "../schema/cli_tokens";
import { secretsMatch } from "./CryptoOps";

/**
 * Signing in the `hypotenuse` CLI, and the token it is signed in with.
 *
 * Two hand-offs carry a person's approval from the dashboard to their terminal,
 * and both live in Redis because both are short-lived and single-use:
 *
 * - **Loopback + PKCE.** The approve page asks `cli-auth:approve` for a one-time
 *   code bound to the person and to the CLI's `code_challenge`, then redirects it
 *   to the CLI's `127.0.0.1` listener. The CLI redeems it with the verifier.
 * - **Device code.** `cli-auth:device` mints a secret `deviceCode` (kept by the
 *   CLI) and a short `userCode` (typed by the person into `/cli/activate`). The
 *   CLI polls with the device code until the person approves.
 *
 * Redis keys hold the sha256 of each secret code, never the code itself, so a
 * Redis dump redeems nothing. The token is minted only at redemption, into
 * Postgres, as a sha256 — its plaintext exists in exactly one HTTP response.
 */

/** The prefix every CLI token carries, so a leaked one is recognizable in a scan. */
export const CLI_TOKEN_PREFIX = "hyp_cli_";

/** One message for every redemption that fails, so a failure says nothing about why. */
export const INVALID_CODE_MESSAGE = "This sign-in code is invalid or expired";

/** One message for every CLI token that does not authenticate. */
export const INVALID_TOKEN_MESSAGE =
  "This CLI sign-in is invalid, revoked, or expired. Run `hypotenuse login` again.";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Letters a person can read off one screen and type on another without
 * confusing two of them: no vowels (so no words), no `0`/`O`, `1`/`I`/`L`.
 * RFC 8628 §6.1's suggestion.
 */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The device name a CLI reports: its hostname, trimmed. */
export const deviceInput = z
  .string()
  .trim()
  .min(1, "A device name is required")
  .max(256, "A device name must be at most 256 characters")
  .describe("The hostname of the machine the CLI runs on");

/**
 * Encode bytes as base62, left-padded to the width the byte count can need.
 * @param bytes - The random bytes.
 * @returns The base62 string.
 */
function base62(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  const width = Math.ceil((bytes.length * 8) / Math.log2(62));
  return out.padStart(width, "0");
}

/**
 * sha256 of a string, hex-encoded. Used for tokens and codes, which are random
 * and long enough that an unsalted hash is the right lookup key.
 * @param value - The secret.
 * @returns Its hex digest.
 */
export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * The PKCE S256 challenge for a verifier: base64url of its sha256, unpadded.
 * @param verifier - The PKCE code verifier.
 * @returns The challenge the CLI would have sent.
 */
export function s256Challenge(verifier: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a new CLI token: `hyp_cli_` and 32 random bytes in base62.
 * @returns The plaintext token.
 */
export function generateCliToken(): string {
  return `${CLI_TOKEN_PREFIX}${base62(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * A random, URL-safe secret code for a Redis hand-off.
 * @returns 32 random bytes in base62.
 */
function generateSecretCode(): string {
  return base62(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A device flow's user code: eight letters from {@link USER_CODE_ALPHABET},
 * shown as `WDJB-MJHT`.
 * @returns The formatted user code.
 */
export function generateUserCode(): string {
  const letters = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length],
  ).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * Normalize what a person typed into the activate page: case and separators
 * are not part of the code.
 * @param typed - The raw input.
 * @returns The canonical `XXXX-XXXX` form, or the cleaned string when it is not eight letters.
 */
export function normalizeUserCode(typed: string): string {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : letters;
}

/** Redis key for a loopback code, by the sha256 of the code. */
const loopbackKey = (code: string) => `cli-auth:code:${sha256Hex(code)}`;
/** Redis key for a device code's state, by the sha256 of the device code. */
const deviceKey = (deviceCode: string) =>
  `cli-auth:device:${sha256Hex(deviceCode)}`;
/** Redis key pointing a user code at its device code's hash. */
const userCodeKey = (userCode: string) => `cli-auth:user-code:${userCode}`;

/** What a loopback code is bound to. */
interface LoopbackGrant {
  userId: number;
  codeChallenge: string;
  device: string;
}

/** A device code's state while it waits for a person. */
interface DeviceGrant {
  device: string;
  userCode: string;
  userId: number | null;
}

/**
 * Store a one-time loopback code for a person who approved a CLI.
 * @param grant - The person, the CLI's PKCE challenge, and its device name.
 * @returns The code, to be handed to the CLI's loopback listener.
 */
export async function createLoopbackCode(grant: LoopbackGrant): Promise<{
  code: string;
  expiresIn: number;
}> {
  const code = generateSecretCode();
  const ttl = config.cliAuth.codeTtlSeconds;
  await api.redis.redis.set(
    loopbackKey(code),
    JSON.stringify(grant),
    "EX",
    ttl,
  );
  return { code, expiresIn: ttl };
}

/**
 * Redeem a loopback code with its PKCE verifier. The code is consumed by the
 * first attempt whatever its outcome, so a wrong verifier burns it.
 * @param code - The one-time code.
 * @param codeVerifier - The verifier whose S256 must equal the stored challenge.
 * @returns The grant the code was bound to.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` with one message for
 *   an unknown, expired, reused, or wrongly verified code.
 */
export async function redeemLoopbackCode(
  code: string,
  codeVerifier: string,
): Promise<LoopbackGrant> {
  const raw = await api.redis.redis.getdel(loopbackKey(code));
  const grant = raw ? (JSON.parse(raw) as LoopbackGrant) : null;
  if (
    !grant ||
    !secretsMatch(s256Challenge(codeVerifier), grant.codeChallenge)
  ) {
    throw invalidCode("code");
  }
  return grant;
}

/**
 * Start a device flow.
 * @param device - The hostname the CLI reported.
 * @returns The secret device code, the user code to show, and its lifetime.
 */
export async function createDeviceCode(device: string): Promise<{
  deviceCode: string;
  userCode: string;
  expiresIn: number;
}> {
  const deviceCode = generateSecretCode();
  const userCode = generateUserCode();
  const ttl = config.cliAuth.deviceCodeTtlSeconds;
  const grant: DeviceGrant = { device, userCode, userId: null };
  // NX on the user code: two live device flows must never share one. A clash
  // in a 19^8 space is vanishingly rare; refusing it is cheaper than reasoning
  // about which CLI a person approved.
  const claimed = await api.redis.redis.set(
    userCodeKey(userCode),
    sha256Hex(deviceCode),
    "EX",
    ttl,
    "NX",
  );
  if (claimed !== "OK") return createDeviceCode(device);
  await api.redis.redis.set(
    deviceKey(deviceCode),
    JSON.stringify(grant),
    "EX",
    ttl,
  );
  return { deviceCode, userCode, expiresIn: ttl };
}

/**
 * Look up the device flow a typed user code belongs to, without approving it.
 * @param typed - What the person typed.
 * @returns The device name and the Redis key of its grant.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown,
 *   expired, or already-used user code.
 */
export async function findDeviceCode(
  typed: string,
): Promise<{ device: string; grantKey: string; userCode: string }> {
  const userCode = normalizeUserCode(typed);
  const hash = await api.redis.redis.get(userCodeKey(userCode));
  const grantKey = hash ? `cli-auth:device:${hash}` : null;
  const raw = grantKey ? await api.redis.redis.get(grantKey) : null;
  const grant = raw ? (JSON.parse(raw) as DeviceGrant) : null;
  if (!grantKey || !grant || grant.userId !== null) {
    throw invalidCode("userCode");
  }
  return { device: grant.device, grantKey, userCode };
}

/**
 * Approve a device flow for a person. The user code is deleted so it cannot be
 * approved twice; the device grant keeps its remaining lifetime for the CLI's
 * next poll.
 * @param found - What {@link findDeviceCode} returned.
 * @param userId - The person approving.
 */
export async function approveDeviceCode(
  found: { grantKey: string; userCode: string; device: string },
  userId: number,
): Promise<void> {
  const grant: DeviceGrant = {
    device: found.device,
    userCode: found.userCode,
    userId,
  };
  await api.redis.redis.set(
    found.grantKey,
    JSON.stringify(grant),
    "KEEPTTL",
    "XX",
  );
  await api.redis.redis.del(userCodeKey(found.userCode));
}

/**
 * Poll a device code.
 * @param deviceCode - The secret the CLI holds.
 * @returns `pending` while nobody has approved, or the approved grant — which
 *   is consumed, so only one poll ever receives it.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown or
 *   expired device code.
 */
export async function pollDeviceCode(
  deviceCode: string,
): Promise<
  { status: "pending" } | { status: "approved"; userId: number; device: string }
> {
  const key = deviceKey(deviceCode);
  const raw = await api.redis.redis.get(key);
  const grant = raw ? (JSON.parse(raw) as DeviceGrant) : null;
  if (!grant) throw invalidCode("deviceCode");
  if (grant.userId === null) return { status: "pending" };
  // Two polls racing on an approved grant: only the one whose delete removed
  // the key gets the token.
  if ((await api.redis.redis.del(key)) !== 1) throw invalidCode("deviceCode");
  return { status: "approved", userId: grant.userId, device: grant.device };
}

/**
 * The refusal every failed redemption shares.
 * @param key - The input that carried the code.
 * @returns The typed error.
 */
function invalidCode(key: string): TypedError {
  return new TypedError({
    message: INVALID_CODE_MESSAGE,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key,
  });
}

/**
 * Insert a CLI token for a person and return its plaintext once.
 * @param userId - Whose token it is.
 * @param device - The hostname the CLI reported.
 * @returns The plaintext token and the stored row.
 */
export async function mintCliToken(
  userId: number,
  device: string,
): Promise<{ token: string; row: CliToken }> {
  const token = generateCliToken();
  const now = Date.now();
  const [row] = await api.db.db
    .insert(cliTokens)
    .values({
      userId,
      device,
      tokenHash: sha256Hex(token),
      lastFour: token.slice(-4),
      lastUsedAt: new Date(now),
      expiresAt: new Date(now + config.cliAuth.tokenTtlDays * DAY_MS),
    })
    .returning();
  return { token, row };
}

/**
 * Resolve a presented CLI token to its row, sliding its expiry forward when the
 * last recorded use is more than a day old. Unknown, revoked, and expired tokens
 * are the same `null`.
 * @param token - The bearer token, `hyp_cli_…`.
 * @returns The live token row, or `null`.
 */
export async function resolveCliToken(token: string): Promise<CliToken | null> {
  const now = new Date();
  const [row] = await api.db.db
    .select()
    .from(cliTokens)
    .where(
      and(
        eq(cliTokens.tokenHash, sha256Hex(token)),
        isNull(cliTokens.revokedAt),
        gt(cliTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return null;

  // At most one write a day per token: the sliding window does not need
  // per-request precision, and a hot CLI loop should not be a hot UPDATE.
  // The predicate makes concurrent requests race harmlessly.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > DAY_MS) {
    const expiresAt = new Date(
      now.getTime() + config.cliAuth.tokenTtlDays * DAY_MS,
    );
    await api.db.db
      .update(cliTokens)
      .set({ lastUsedAt: now, expiresAt })
      .where(
        and(
          eq(cliTokens.id, row.id),
          or(
            isNull(cliTokens.lastUsedAt),
            lt(cliTokens.lastUsedAt, sql`now() - interval '1 day'`),
          ),
        ),
      );
    return { ...row, lastUsedAt: now, expiresAt };
  }
  return row;
}

/**
 * Shape a CLI token row for the API. The hash is dropped; `status` is decided
 * here so no client compares clocks.
 * @param row - The token row.
 * @param currentId - The id of the token the caller is authenticated with, if any.
 * @returns The serialized token.
 */
export function serializeCliToken(row: CliToken, currentId?: number) {
  const status = row.revokedAt
    ? "revoked"
    : row.expiresAt.getTime() <= Date.now()
      ? "expired"
      : "active";
  return {
    id: row.id,
    device: row.device,
    lastFour: row.lastFour,
    status,
    current: currentId !== undefined && row.id === currentId,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    expiresAt: row.expiresAt.getTime(),
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}
