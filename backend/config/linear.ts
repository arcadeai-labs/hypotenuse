import { loadFromEnvIfSet } from "keryx";

/**
 * The scopes every install requests, in the order Linear documents them.
 * `admin` is absent because Linear refuses it with `actor=app`; `customer:*`,
 * `initiative:*`, and `timeSchedule:write` are absent because nothing needs
 * them. Adding one is a re-consent, which `prompt=consent` already forces.
 */
export const LINEAR_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
  "issues:create",
  "comments:create",
] as const;

/**
 * The deployment's one Linear OAuth application, and where Linear lives. The
 * URLs are overridable so tests can point at an in-process finear.
 *
 * - `apiUrl` — GraphQL (`/graphql`) and the OAuth token and revoke endpoints.
 * - `oauthUrl` — the authorize (consent) page, which Linear serves from its app
 *   origin rather than its API origin.
 * - `refreshWindowMs` — `linear:refresh-tokens` refreshes any installation whose
 *   access token expires within this long. Thirty minutes, so the five-minute
 *   clock gets six chances before a 24-hour token lapses.
 * - `stateTtlSeconds` — how long a parked `state` waits for its callback.
 * - `catalogTtlMs` — how long `linear:catalog` serves one installation's teams,
 *   projects, and labels from Redis before asking Linear again.
 * - `requestTimeoutMs` — the deadline on every call to Linear. A request that
 *   waits on Linear must not wait forever.
 */
export const configLinear = {
  clientId: await loadFromEnvIfSet("LINEAR_CLIENT_ID", ""),
  clientSecret: await loadFromEnvIfSet("LINEAR_CLIENT_SECRET", ""),
  webhookSecret: await loadFromEnvIfSet("LINEAR_WEBHOOK_SECRET", ""),
  apiUrl: await loadFromEnvIfSet("LINEAR_API_URL", "https://api.linear.app"),
  oauthUrl: await loadFromEnvIfSet("LINEAR_OAUTH_URL", "https://linear.app"),
  scopes: [...LINEAR_SCOPES] as string[],
  refreshWindowMs: await loadFromEnvIfSet(
    "LINEAR_REFRESH_WINDOW_MS",
    30 * 60 * 1000,
  ),
  stateTtlSeconds: await loadFromEnvIfSet("LINEAR_STATE_TTL_SECONDS", 600),
  catalogTtlMs: await loadFromEnvIfSet("LINEAR_CATALOG_TTL_MS", 60 * 1000),
  requestTimeoutMs: await loadFromEnvIfSet("LINEAR_REQUEST_TIMEOUT_MS", 10_000),
};

declare module "keryx" {
  interface KeryxConfig {
    linear: typeof configLinear;
  }
}
