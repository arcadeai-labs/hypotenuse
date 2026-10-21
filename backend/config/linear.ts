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
 * - `refreshWindowMs` — `integrations:refresh-tokens` refreshes any integration whose
 *   access token expires within this long. Thirty minutes, so the five-minute
 *   clock gets six chances before a 24-hour token lapses.
 * - `stateTtlSeconds` — how long a parked `state` waits for its callback.
 * - `catalogTtlMs` — how long `integration:catalog` serves one integration's teams,
 *   projects, and labels from Redis before asking Linear again.
 * - `requestTimeoutMs` — the deadline on every call to Linear. A request that
 *   waits on Linear must not wait forever.
 *
 * Webhook ingress and the activity outbox:
 *
 * - `webhookSecretPrevious` — the signing secret being rotated out. While it is
 *   set, a delivery signed with either secret verifies; unset it once Linear
 *   signs with the new one (docs/DEPLOY.md).
 * - `webhookMaxBodyBytes` — the largest delivery read; 5 MiB, the limit
 *   `@linear/sdk`'s own webhook client uses. Larger answers 413 unread.
 * - `webhookToleranceMs` — how far the signed `webhookTimestamp` may be from
 *   now before the delivery is refused as a replay.
 * - `eventRetentionDays` — how long `trigger_events` rows live.
 * - `requestsPerHour` / `bucketBurst` / `bucketReserve` — the per-integration
 *   token bucket the outbox spends: Linear's 5,000 requests an hour per app
 *   user, a burst of 60, and the last 10 tokens kept for acknowledgements.
 * - `deliverMaxAttempts` — how many times a retryable failure is retried before
 *   an outbound activity is `failed`.
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
  webhookSecretPrevious: await loadFromEnvIfSet(
    "LINEAR_WEBHOOK_SECRET_PREVIOUS",
    "",
  ),
  webhookMaxBodyBytes: await loadFromEnvIfSet(
    "LINEAR_WEBHOOK_MAX_BODY_BYTES",
    5 * 1024 * 1024,
  ),
  webhookToleranceMs: await loadFromEnvIfSet(
    "LINEAR_WEBHOOK_TOLERANCE_MS",
    60_000,
  ),
  eventRetentionDays: await loadFromEnvIfSet("LINEAR_EVENT_RETENTION_DAYS", 14),
  requestsPerHour: await loadFromEnvIfSet("LINEAR_REQUESTS_PER_HOUR", 5000),
  bucketBurst: await loadFromEnvIfSet("LINEAR_BUCKET_BURST", 60),
  bucketReserve: await loadFromEnvIfSet("LINEAR_BUCKET_RESERVE", 10),
  deliverMaxAttempts: await loadFromEnvIfSet("LINEAR_DELIVER_MAX_ATTEMPTS", 10),
};

declare module "keryx" {
  interface KeryxConfig {
    linear: typeof configLinear;
  }
}
