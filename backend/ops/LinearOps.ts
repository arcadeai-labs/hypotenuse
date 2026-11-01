import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import type { OpenInstallation } from "../platforms/types";
import {
  type BotInstallation,
  botInstallations,
} from "../schema/bot_installations";
import { openInstallation, sealCredentials } from "./InstallationCredentialOps";
import { runRedisScript } from "./RedisScriptOps";

/**
 * **The Linear API client** — the single caller of Linear's GraphQL API and
 * its OAuth token endpoint, for every bot's Linear app.
 *
 * - **GraphQL** is `POST <apiUrl>/graphql` with the installation's OAuth
 *   access token as a bearer credential. Linear answers errors in an
 *   `errors[]` array whose `extensions.code` names them; rate limiting is
 *   HTTP 400 with `extensions.code: "RATELIMITED"` and the reset time in
 *   `X-RateLimit-Requests-Reset` (epoch ms) — never a 429
 *   (https://linear.app/developers/rate-limiting).
 * - **Pacing.** Every call made for an installation first takes a token from
 *   its bucket in Redis (`reserve-bucket.lua`). The bucket keeps a reserve
 *   only acknowledgements and a stop's answer may take, so a busy bot can
 *   always tell Linear it heard a new session inside Linear's ten seconds.
 *   An empty bucket, like `RATELIMITED`, is a {@link LinearApiError} carrying
 *   how long to wait: the outbox reschedules the row, and no worker sleeps.
 * - **Tokens.** An `actor=app` install yields an access token that lives a
 *   day and a refresh token. {@link linearCall} refreshes one that is about to
 *   expire, and once more when Linear refuses it; `installations:refresh-tokens`
 *   refreshes ahead of time. A refresh runs under the installation's row lock,
 *   so two workers never spend one refresh token. Linear honours a refresh
 *   token for 30 minutes after it was rotated, so a refresh whose answer was
 *   lost is retried with the same token. Only `invalid_grant` marks the
 *   installation `error`; nothing here ever calls Linear's revoke endpoint,
 *   because revoking any token of an `actor=app` install uninstalls the app.
 */

/** Codes that mean the call may succeed if tried again later. */
const RETRYABLE = new Set([
  "RATELIMITED",
  "network",
  "http_5xx",
  "INTERNAL_SERVER_ERROR",
]);

/** Codes that mean the access token no longer works. */
const AUTH_FAILURES = new Set([
  "AUTHENTICATION_ERROR",
  "authentication",
  "invalid_token",
  "http_401",
]);

/** A Linear call that did not succeed, in Linear's own words. */
export class LinearApiError extends Error {
  /**
   * @param operation - The GraphQL operation, or `oauth/token`.
   * @param code - Linear's code (`extensions.code`, or the OAuth `error`), or `network` / `http_5xx`.
   * @param detail - Linear's message.
   * @param retryAfterMs - How long Linear (or the bucket) asked us to wait.
   */
  constructor(
    public operation: string,
    public code: string,
    public detail: string,
    public retryAfterMs?: number,
  ) {
    super(`Linear's ${operation} answered ${code}: ${detail}`);
    this.name = "LinearApiError";
  }

  /** Whether trying again later may succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** Whether the access token no longer works. */
  get authFailure(): boolean {
    return AUTH_FAILURES.has(this.code);
  }

  /** Whether Linear already has what was sent (a replayed activity id). */
  get alreadyDone(): boolean {
    return (
      this.code === "CONFLICT" ||
      /already exists/i.test(this.detail) ||
      /duplicate/i.test(this.detail)
    );
  }
}

/** What Linear's token endpoint grants. */
export interface LinearTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
}

/**
 * The API origin, without a trailing slash.
 * @returns `config.platforms.linear.apiUrl`.
 */
function apiOrigin(): string {
  return config.platforms.linear.apiUrl.replace(/\/+$/, "");
}

/**
 * **Call Linear's OAuth token endpoint** (form-encoded, as OAuth requires).
 * @param form - The grant's fields.
 * @returns The tokens.
 * @throws {LinearApiError} With Linear's `error` (`invalid_grant`), or `network` / `http_5xx`.
 */
export async function linearTokenRequest(
  form: Record<string, string>,
): Promise<LinearTokenGrant> {
  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(config.platforms.linear.requestTimeoutMs),
    });
  } catch (e) {
    throw new LinearApiError(
      "oauth/token",
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => {});
    throw new LinearApiError("oauth/token", "http_5xx", `HTTP ${res.status}`);
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LinearApiError("oauth/token", "network", "not JSON");
  }
  if (!res.ok || typeof body.access_token !== "string") {
    throw new LinearApiError(
      "oauth/token",
      typeof body.error === "string" ? body.error : `http_${res.status}`,
      typeof body.error_description === "string"
        ? body.error_description
        : "the token endpoint refused the grant",
    );
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : null,
    scopes: String(body.scope ?? "")
      .split(/[ ,]+/)
      .filter(Boolean),
  };
}

/**
 * Take a token from an installation's bucket.
 * @param installationId - The installation.
 * @param reserved - An acknowledgement or a stop's answer, which may draw on the reserve.
 * @returns `0`, or how many milliseconds until a token is free.
 */
export async function takeLinearToken(
  installationId: number,
  reserved: boolean,
): Promise<number> {
  const { bucketCapacity, bucketRefillPerSecond, bucketReserve } =
    config.platforms.linear;
  return Number(
    await runRedisScript(
      "reserve-bucket",
      [`linear:bucket:${installationId}`],
      [
        bucketCapacity,
        bucketRefillPerSecond,
        Date.now(),
        bucketReserve,
        reserved ? 1 : 0,
      ],
    ),
  );
}

/** How a GraphQL call is authenticated and paced. */
export interface LinearGraphqlOptions {
  /** The installation whose bucket the call takes a token from. */
  installationId?: number;
  /** Draw on the bucket's reserve (an acknowledgement, a stop's answer). */
  reserved?: boolean;
}

/**
 * The operation name of a GraphQL document, for errors and logs.
 * @param query - The document.
 * @returns Its name, or `graphql`.
 */
function operationName(query: string): string {
  return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "graphql";
}

/**
 * **Run one GraphQL document** with a raw access token.
 * @param token - The access token.
 * @param query - The document.
 * @param variables - Its variables.
 * @param opts - The installation's bucket.
 * @returns The `data` object.
 * @throws {LinearApiError} For an empty bucket, `RATELIMITED`, an auth failure, any `errors[]`, or a network or 5xx failure.
 */
export async function linearGraphql<T = Record<string, unknown>>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: LinearGraphqlOptions = {},
): Promise<T> {
  const op = operationName(query);
  if (opts.installationId !== undefined) {
    const wait = await takeLinearToken(
      opts.installationId,
      opts.reserved === true,
    );
    if (wait > 0) {
      throw new LinearApiError(op, "RATELIMITED", "the bucket is empty", wait);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "Hypotenuse-Linear/1",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(config.platforms.linear.requestTimeoutMs),
    });
  } catch (e) {
    throw new LinearApiError(
      op,
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => {});
    throw new LinearApiError(op, "http_5xx", `HTTP ${res.status}`);
  }
  let body: {
    data?: T;
    errors?: { message?: string; extensions?: { code?: string } }[];
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    if (res.status === 401) {
      throw new LinearApiError(op, "http_401", "unauthorized");
    }
    throw new LinearApiError(op, "network", "not JSON");
  }
  const first = body.errors?.[0];
  if (first) {
    const code = first.extensions?.code ?? `http_${res.status}`;
    let retryAfterMs: number | undefined;
    if (code === "RATELIMITED") {
      const reset = Number(res.headers.get("x-ratelimit-requests-reset"));
      retryAfterMs =
        Number.isFinite(reset) && reset > Date.now()
          ? reset - Date.now()
          : 60_000;
    }
    throw new LinearApiError(
      op,
      res.status === 401 && code === `http_${res.status}` ? "http_401" : code,
      first.message ?? "error",
      retryAfterMs,
    );
  }
  if (!res.ok || !body.data) {
    throw new LinearApiError(op, `http_${res.status}`, "no data");
  }
  return body.data;
}

/**
 * The Redis key that records a refresh in flight (never the token).
 * @param installationId - The installation.
 * @returns The key.
 */
function inflightKey(installationId: number): string {
  return `linear:refresh:${installationId}`;
}

/** What a refresh did. */
export type RefreshOutcome =
  | { kind: "fresh"; installation: BotInstallation }
  | { kind: "refreshed"; installation: BotInstallation }
  | { kind: "refused"; installation: BotInstallation };

/**
 * **Refresh an installation's access token**, under its row lock.
 *
 * | Case | Then |
 * |---|---|
 * | not active, or no refresh token | nothing (`fresh`) |
 * | `rejected` given and the row already holds another token | another worker refreshed it (`fresh`) |
 * | the token expires later than `refreshBeforeMs` from now, not forced | nothing (`fresh`) |
 * | Linear grants new tokens | they are sealed, the expiry recorded (`refreshed`) |
 * | Linear answers `invalid_grant` | the installation is `error`, its error says to install it again (`refused`) |
 * | anything else (network, 5xx) | the tokens are left as they were and the error thrown; the next try replays the same refresh token within Linear's grace |
 * @param installationId - The installation.
 * @param opts.force - Refresh even when the token is not about to expire.
 * @param opts.rejected - The access token Linear just refused.
 * @returns What happened.
 * @throws {LinearApiError} For a transient failure.
 */
export async function refreshLinearToken(
  installationId: number,
  opts: { force?: boolean; rejected?: string } = {},
): Promise<RefreshOutcome> {
  let transient: LinearApiError | null = null;
  const outcome = await api.db.db.transaction(
    async (tx): Promise<RefreshOutcome> => {
      const [row] = await tx
        .select()
        .from(botInstallations)
        .where(eq(botInstallations.id, installationId))
        .for("update");
      if (!row) throw new Error("The installation no longer exists");
      const inst = openInstallation(row);
      const refreshToken = inst.credentials.refreshToken;
      if (row.status !== "active" || typeof refreshToken !== "string") {
        return { kind: "fresh", installation: row };
      }
      if (
        opts.rejected !== undefined &&
        inst.credentials.accessToken !== opts.rejected
      ) {
        return { kind: "fresh", installation: row };
      }
      const expiresAt = Number(row.config.accessTokenExpiresAt ?? 0);
      if (
        !opts.force &&
        opts.rejected === undefined &&
        expiresAt > Date.now() + config.platforms.linear.refreshBeforeMs
      ) {
        return { kind: "fresh", installation: row };
      }
      const key = inflightKey(installationId);
      const replay = await api.redis.redis.get(key);
      if (!replay) {
        await api.redis.redis.set(
          key,
          String(Date.now()),
          "PX",
          config.platforms.linear.refreshReplayGraceMs,
        );
      } else {
        api.logger.warn("replaying a Linear refresh whose answer was lost", {
          installationId,
          startedAt: Number(replay),
        });
      }
      let grant: LinearTokenGrant;
      try {
        grant = await linearTokenRequest({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: String(row.config.clientId ?? ""),
          client_secret: String(inst.credentials.clientSecret ?? ""),
        });
      } catch (e) {
        if (e instanceof LinearApiError && e.code === "invalid_grant") {
          const [refused] = await tx
            .update(botInstallations)
            .set({
              status: "error",
              lastError: replay
                ? "Linear refused to replay a refresh whose answer was lost. Install the app again."
                : "Linear refused the refresh token: the app was uninstalled or its access revoked. Install it again.",
            })
            .where(eq(botInstallations.id, installationId))
            .returning();
          await api.redis.redis.del(key);
          return { kind: "refused", installation: refused };
        }
        transient =
          e instanceof LinearApiError
            ? e
            : new LinearApiError("oauth/token", "network", String(e));
        return { kind: "fresh", installation: row };
      }
      const [updated] = await tx
        .update(botInstallations)
        .set({
          credentials: sealCredentials({
            ...inst.credentials,
            accessToken: grant.accessToken,
            refreshToken: grant.refreshToken ?? refreshToken,
          }),
          credentialVersion: row.credentialVersion + 1,
          config: {
            ...row.config,
            accessTokenExpiresAt: grant.expiresAt,
            ...(grant.scopes.length > 0 ? { scopes: grant.scopes } : {}),
          },
          lastError: null,
        })
        .where(eq(botInstallations.id, installationId))
        .returning();
      await api.redis.redis.del(key);
      return { kind: "refreshed", installation: updated };
    },
  );
  if (transient) throw transient;
  return outcome;
}

/**
 * An installation's access token, refreshed first when it is about to expire.
 * @param inst - The installation, opened.
 * @returns The token and the installation as it now is.
 * @throws {LinearApiError} When the installation has no token, or a refresh failed.
 */
async function accessTokenOf(
  inst: OpenInstallation,
): Promise<{ token: string; inst: OpenInstallation }> {
  const expiresAt = Number(inst.installation.config.accessTokenExpiresAt ?? 0);
  let current = inst;
  if (
    expiresAt > 0 &&
    expiresAt <= Date.now() + 60_000 &&
    typeof inst.credentials.refreshToken === "string"
  ) {
    const r = await refreshLinearToken(inst.installation.id);
    current = openInstallation(r.installation);
  }
  const token = current.credentials.accessToken;
  if (typeof token !== "string" || !token) {
    throw new LinearApiError(
      "graphql",
      "authentication",
      "the installation has no access token: install the app",
    );
  }
  if (current.installation.status !== "active") {
    throw new LinearApiError(
      "graphql",
      "authentication",
      current.installation.lastError ?? "the installation is not active",
    );
  }
  return { token, inst: current };
}

/**
 * **Call Linear as an installation**: its token (refreshed when due), its
 * bucket, and one refresh and retry when Linear refuses the token.
 * @param inst - The installation, opened.
 * @param query - The document.
 * @param variables - Its variables.
 * @param opts.reserved - Draw on the bucket's reserve.
 * @returns The `data` object.
 * @throws {LinearApiError} As {@link linearGraphql}.
 */
export async function linearCall<T = Record<string, unknown>>(
  inst: OpenInstallation,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { reserved?: boolean } = {},
): Promise<T> {
  const { token, inst: current } = await accessTokenOf(inst);
  const id = current.installation.id;
  try {
    return await linearGraphql<T>(token, query, variables, {
      installationId: id,
      reserved: opts.reserved,
    });
  } catch (e) {
    if (!(e instanceof LinearApiError) || !e.authFailure) throw e;
    const r = await refreshLinearToken(id, { rejected: token });
    const again = openInstallation(r.installation);
    const fresh = again.credentials.accessToken;
    if (r.kind === "refused" || typeof fresh !== "string" || fresh === token) {
      throw e;
    }
    return linearGraphql<T>(fresh, query, variables, {
      installationId: id,
      reserved: opts.reserved,
    });
  }
}

/**
 * A UUID v4 derived from a string, so a retried write carries the same id
 * and Linear recognizes the retry (`agentActivityCreate` takes the client's id).
 * @param seed - What names the write (an outbox row and its part).
 * @returns A version-4 UUID.
 */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(`hypotenuse:${seed}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
