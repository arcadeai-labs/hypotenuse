import { eq } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only: brings the `config.linear` augmentation into every program that
// type-checks this file.
import type {} from "../config/linear";
import { type Integration, integrations } from "../schema/integrations";
import { s256Challenge, sha256Hex } from "./CliTokenOps";
import { decryptSecret, encryptSecret, lastFourOf } from "./CryptoOps";
import {
  LinearIntegrationUnavailableError,
  LinearUnavailableError,
  linearCallbackUrl,
  linearFetch,
} from "./LinearOps";
import { getAdminUserIds } from "./MembershipOps";
import { enqueueNotification } from "./NotificationOps";

/**
 * The OAuth half of the Linear connection: the authorize URL, the parked
 * `state`, the code exchange, the refresh clock's one function, and revocation.
 *
 * Linear's `actor=app` access tokens last 24 hours and its refresh tokens
 * **rotate**: each refresh spends the old refresh token and answers a new pair.
 * A refresh whose response is lost can be replayed for 30 minutes and answers
 * the same new pair. {@link refreshIntegrationTokens} is built around both
 * facts.
 */

/** Linear refused a grant outright (`invalid_grant`): the tokens are dead. */
export class LinearGrantRefusedError extends Error {
  /** Linear's `error` code. */
  readonly code: string;

  /**
   * @param code - Linear's `error` code, e.g. `invalid_grant`.
   */
  constructor(code: string) {
    super(`Linear refused the grant (${code})`);
    this.name = "LinearGrantRefusedError";
    this.code = code;
  }
}

/** What Linear's token endpoint answers, normalized. */
export interface LinearTokenGrant {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  scopes: string[];
}

/** What a parked `state` remembers about the admin who started the install. */
export interface ParkedLinearState {
  projectId: number;
  userId: number;
  codeVerifier: string;
}

/**
 * Normalize the `scope` Linear granted. Apps created before December 2023
 * receive an array; newer ones a string, separated by spaces (as OAuth says) or
 * commas (as Linear's authorize URL takes them).
 * @param scope - The token response's `scope`.
 * @returns The scopes, de-duplicated, in the order given.
 */
export function parseScopes(scope: unknown): string[] {
  const raw = Array.isArray(scope)
    ? scope.map(String)
    : typeof scope === "string"
      ? scope.split(/[\s,]+/)
      : [];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

/**
 * Random URL-safe bytes.
 * @param bytes - How many random bytes.
 * @returns base64url, unpadded.
 */
function randomUrlSafe(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

/** Redis key for a parked state, by its sha256 so a dump redeems nothing. */
const stateKey = (state: string) => `linear:oauth:state:${sha256Hex(state)}`;

/** Redis key recording a refresh that was sent but has not committed. */
export const inflightRefreshKey = (integrationId: number) =>
  `linear:refresh:inflight:${integrationId}`;

/** How long Linear honours a replayed refresh token. */
export const REFRESH_REPLAY_GRACE_MS = 30 * 60 * 1000;

/**
 * Linear's consent-screen URL for an `actor=app` install.
 *
 * `prompt=consent` always, so reconnecting after a scope change — or connecting
 * a second workspace from the same Linear login — shows the screen rather than
 * reusing the last grant. PKCE as well as the client secret, because a code can
 * leak through a referrer or a proxy log and the verifier never travels.
 * @param state - The single-use state.
 * @param codeChallenge - The S256 PKCE challenge.
 * @returns The absolute authorize URL.
 */
export function buildAuthorizeUrl(
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(
    `${config.linear.oauthUrl.replace(/\/+$/, "")}/oauth/authorize`,
  );
  url.searchParams.set("client_id", config.linear.clientId);
  url.searchParams.set("redirect_uri", linearCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.linear.scopes.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("actor", "app");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Mint a state and a PKCE verifier for one install attempt, park them in Redis
 * for `stateTtlSeconds`, and answer the authorize URL.
 * @param grant - The project being connected and the admin connecting it.
 * @returns The URL to send the admin's browser to.
 */
export async function parkState(grant: {
  projectId: number;
  userId: number;
}): Promise<{ authorizeUrl: string; expiresIn: number }> {
  const state = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(48);
  const parked: ParkedLinearState = { ...grant, codeVerifier };
  const ttl = config.linear.stateTtlSeconds;
  await api.redis.redis.set(stateKey(state), JSON.stringify(parked), "EX", ttl);
  return {
    authorizeUrl: buildAuthorizeUrl(state, s256Challenge(codeVerifier)),
    expiresIn: ttl,
  };
}

/**
 * Take a parked state, once. A replayed callback finds nothing.
 * @param state - The `state` the callback carried.
 * @returns What was parked, or null when it expired or was already taken.
 */
export async function collectState(
  state: string,
): Promise<ParkedLinearState | null> {
  const raw = await api.redis.redis.getdel(stateKey(state));
  return raw ? (JSON.parse(raw) as ParkedLinearState) : null;
}

/**
 * POST a form to Linear's token endpoint with HTTP Basic client auth.
 * @param form - The grant's fields.
 * @returns The normalized grant.
 * @throws {LinearGrantRefusedError} When Linear answers a 4xx OAuth error.
 * @throws {LinearUnavailableError} On no response, a 5xx, or a malformed body.
 */
async function requestToken(
  form: Record<string, string>,
): Promise<LinearTokenGrant> {
  const { clientId, clientSecret } = config.linear;
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString("base64");
  const response = await linearFetch("/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status >= 500) {
    throw new LinearUnavailableError(
      `Linear's token endpoint answered HTTP ${response.status}`,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    throw new LinearGrantRefusedError(
      typeof body?.error === "string" ? body.error : `http_${response.status}`,
    );
  }
  if (
    !body ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  ) {
    throw new LinearUnavailableError(
      "Linear's token endpoint answered without an access and refresh token",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in ?? 0) || 86_399,
    scopes: parseScopes(body.scope),
  };
}

/**
 * Exchange an authorization code (with its PKCE verifier) for tokens.
 * @param code - The code from the callback.
 * @param codeVerifier - The verifier parked with the state.
 * @returns The grant.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<LinearTokenGrant> {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: linearCallbackUrl(),
    code_verifier: codeVerifier,
  });
}

/**
 * The columns a fresh grant writes.
 * @param grant - What Linear answered.
 * @returns The token columns, sealed.
 */
export function tokenColumns(grant: LinearTokenGrant) {
  return {
    accessTokenEncrypted: encryptSecret(grant.accessToken),
    refreshTokenEncrypted: encryptSecret(grant.refreshToken),
    accessTokenLastFour: lastFourOf(grant.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + grant.expiresIn * 1000),
  };
}

/** Options for {@link refreshIntegrationTokens}. */
export interface RefreshOptions {
  /**
   * The access token Linear just refused with a 401. If the row no longer holds
   * it, somebody else already refreshed and this call returns their result.
   */
  rejectedAccessToken?: string;
  /** Refresh even when the token is not near expiry. */
  force?: boolean;
}

/**
 * Refresh an integration's tokens — the one function the refresh clock and an
 * inline 401 both call.
 *
 * 1. **Row lock.** `SELECT … FOR UPDATE` serializes every refresher across
 *    processes. The second one re-reads, finds a fresh token (or, after a 401,
 *    a different one), and returns without calling Linear.
 * 2. **Record the attempt** in Redis (`linear:refresh:inflight:<id>`, the start
 *    time only, for 30 minutes) before spending the refresh token.
 * 3. **Success** writes the new access *and* refresh token in the same
 *    transaction, then clears the record.
 * 4. **No answer** (network, timeout, 5xx, a lost response) leaves the tokens
 *    alone and only notes the failure on `refreshError`, under the same lock so
 *    it cannot overwrite a later success. The row still holds the refresh token
 *    that was just spent, and the next attempt
 *    presents it again — which Linear honours for 30 minutes with the same new
 *    pair. That replay is the whole use of the grace period: it turns a lost
 *    response from "logged out of the workspace" into a retry.
 * 5. **`invalid_grant`** — the grace passed, or the grant was revoked in Linear —
 *    marks the row `error`, says why on `refreshError`, and notifies the
 *    project's admins in the same transaction. Nothing more is sent to Linear
 *    until an admin reconnects.
 *
 * Any other refusal (a rotated client secret, say) is reported on
 * `refreshError` but leaves the row `active`: fixing the deployment's
 * configuration should recover every workspace without anyone reconnecting.
 * @param integrationId - The integration.
 * @param options - Why this refresh is happening.
 * @returns The row after the attempt.
 * @throws {LinearUnavailableError} When Linear did not answer (the tokens are unchanged).
 * @throws {LinearIntegrationUnavailableError} When the row no longer exists.
 */
export async function refreshIntegrationTokens(
  integrationId: number,
  options: RefreshOptions = {},
): Promise<Integration> {
  let transient: Error | null = null;
  let settled = false;
  let refused: Integration | null = null;

  const row = await api.db.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .for("update");
    if (!current) {
      throw new LinearIntegrationUnavailableError(
        "This Linear integration no longer exists",
      );
    }
    if (current.status !== "active" || !current.refreshTokenEncrypted) {
      return current;
    }
    if (options.rejectedAccessToken !== undefined) {
      const held = current.accessTokenEncrypted
        ? decryptSecret(current.accessTokenEncrypted)
        : null;
      if (held !== options.rejectedAccessToken) return current;
    } else if (
      !options.force &&
      current.accessTokenExpiresAt &&
      current.accessTokenExpiresAt.getTime() >
        Date.now() + config.linear.refreshWindowMs
    ) {
      return current;
    }

    const key = inflightRefreshKey(integrationId);
    const previous = await api.redis.redis.get(key);
    if (!previous) {
      await api.redis.redis.set(
        key,
        JSON.stringify({ startedAt: Date.now() }),
        "PX",
        REFRESH_REPLAY_GRACE_MS,
      );
    } else {
      api.logger.warn(
        "replaying a Linear refresh whose response never committed",
        { integrationId, startedAt: JSON.parse(previous).startedAt },
      );
    }

    let grant: LinearTokenGrant;
    try {
      grant = await requestToken({
        grant_type: "refresh_token",
        refresh_token: decryptSecret(current.refreshTokenEncrypted),
      });
    } catch (e) {
      if (e instanceof LinearGrantRefusedError && e.code === "invalid_grant") {
        settled = true;
        const [updated] = await tx
          .update(integrations)
          .set({
            status: "error",
            refreshFailedAt: new Date(),
            refreshError: previous
              ? "Linear refused to replay a refresh whose response was lost. An admin must reconnect Linear."
              : "Linear refused the refresh token: the app was uninstalled or its access revoked in Linear. An admin must reconnect Linear.",
          })
          .where(eq(integrations.id, integrationId))
          .returning();
        await enqueueNotification(tx, {
          projectId: current.projectId,
          userIds: await getAdminUserIds(tx, current.projectId),
          template: "linear-refresh-failed",
          payload: { workspaceName: current.workspaceName },
          linkPath: "/settings/integrations",
        });
        refused = updated;
        return updated;
      }
      // Recorded under the same lock, so it can never land on top of a later
      // refresher's success. The tokens are left exactly as they were.
      transient = e instanceof Error ? e : new Error(String(e));
      const [noted] = await tx
        .update(integrations)
        .set({
          refreshFailedAt: new Date(),
          refreshError: `The last refresh failed and will be retried: ${transient.message}`,
        })
        .where(eq(integrations.id, integrationId))
        .returning();
      return noted;
    }

    settled = true;
    const [updated] = await tx
      .update(integrations)
      .set({
        ...tokenColumns(grant),
        scopes: grant.scopes.length > 0 ? grant.scopes : current.scopes,
        lastRefreshedAt: new Date(),
        refreshFailedAt: null,
        refreshError: null,
      })
      .where(eq(integrations.id, integrationId))
      .returning();
    return updated;
  });

  if (settled) await api.redis.redis.del(inflightRefreshKey(integrationId));
  if (refused) {
    api.logger.warn("a Linear integration's refresh was refused", {
      integrationId,
    });
  }
  if (transient) {
    const failure = transient as Error;
    throw failure instanceof LinearUnavailableError
      ? failure
      : new LinearUnavailableError(failure.message);
  }
  return row;
}

/**
 * Revoke one token at Linear. Linear answers 400 for a token already revoked —
 * revoking either of an `actor=app` install's tokens revokes the whole install,
 * so the second of a pair always gets it — and 401 for one it does not know.
 * Both mean the token no longer works, which is what was asked for.
 * @param token - The access or refresh token.
 * @param hint - Which kind it is.
 * @throws {LinearUnavailableError} When Linear did not answer; nothing is forgotten.
 */
export async function revokeToken(
  token: string,
  hint: "access_token" | "refresh_token",
): Promise<void> {
  const response = await linearFetch("/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
  });
  if (response.status >= 500) {
    throw new LinearUnavailableError(
      `Linear's revoke endpoint answered HTTP ${response.status}`,
    );
  }
  // Drain the body so the connection is reusable.
  await response.arrayBuffer().catch(() => undefined);
}

/**
 * Revoke both of an integration's tokens at Linear.
 * @param integration - The row (its tokens are read, not changed).
 */
export async function revokeIntegrationTokens(
  integration: Integration,
): Promise<void> {
  if (integration.accessTokenEncrypted) {
    await revokeToken(
      decryptSecret(integration.accessTokenEncrypted),
      "access_token",
    );
  }
  if (integration.refreshTokenEncrypted) {
    await revokeToken(
      decryptSecret(integration.refreshTokenEncrypted),
      "refresh_token",
    );
  }
}

/**
 * Every way `linear:callback` can refuse, as the short code it puts on the
 * dashboard redirect (`/settings/integrations?type=linear&error=<code>`):
 *
 * | Code | Means |
 * |---|---|
 * | `state_expired` | no parked state: it expired, was already used, or never existed |
 * | `state_mismatch` | the browser finishing the install is not signed in as the admin who started it |
 * | `denied` | the Linear admin declined on the consent screen |
 * | `exchange_failed` | Linear refused the code, or did not answer |
 * | `forbidden` | the person who started the install is no longer an admin of the project |
 * | `workspace_taken` | that Linear workspace is connected to another project |
 * | `workspace_changed` | this project is connected to a different workspace; disconnect it first |
 */
export const LINEAR_CALLBACK_ERRORS = [
  "state_expired",
  "state_mismatch",
  "denied",
  "exchange_failed",
  "forbidden",
  "workspace_taken",
  "workspace_changed",
] as const;

/** One of {@link LINEAR_CALLBACK_ERRORS}. */
export type LinearCallbackError = (typeof LINEAR_CALLBACK_ERRORS)[number];
