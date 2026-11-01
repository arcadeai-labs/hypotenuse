import { loadFromEnvIfSet } from "keryx";

/**
 * The channel framework: platform ingress, event processing, the
 * interactive surface, escalation, and the rate limits that defend a bot
 * whose only gate is the platform's own permissions. Read at use, so a suite
 * may change one for a test and put it back.
 */
export const configPlatforms = {
  /** How old a signed delivery may be before it is refused. */
  signatureToleranceSeconds: await loadFromEnvIfSet(
    "PLATFORM_SIGNATURE_TOLERANCE_SECONDS",
    300,
  ),
  /** The largest webhook body read, in bytes. */
  maxBodyBytes: await loadFromEnvIfSet("PLATFORM_MAX_BODY_BYTES", 1_048_576),
  /** How often `triggers:process-pending` sweeps events processing missed. */
  processPendingFrequencyMs: await loadFromEnvIfSet(
    "TRIGGERS_PROCESS_PENDING_FREQUENCY_MS",
    5_000,
  ),
  /** How long an event waits before the sweep picks it up (its own job runs first). */
  processPendingGraceMs: await loadFromEnvIfSet(
    "TRIGGERS_PROCESS_PENDING_GRACE_MS",
    5_000,
  ),
  /** Attempts at processing one event before it is left `failed`. */
  processAttempts: await loadFromEnvIfSet("TRIGGERS_PROCESS_ATTEMPTS", 3),
  /** How long `stream` rows are coalesced: one row at most this often. */
  streamCoalesceMs: await loadFromEnvIfSet("STREAM_COALESCE_MS", 250),
  /** How many conversations `outbox:deliver-due` delivers at once. */
  deliverConcurrency: await loadFromEnvIfSet("OUTBOX_DELIVER_CONCURRENCY", 8),
  /** How long one conversation's delivery lease lasts. */
  deliverLeaseMs: await loadFromEnvIfSet("OUTBOX_DELIVER_LEASE_MS", 60_000),
  /** The most help requests one conversation may raise. */
  helpCapPerConversation: await loadFromEnvIfSet(
    "HELP_CAP_PER_CONVERSATION",
    5,
  ),
  /** How long a help request waits when the bot names no timeout, in seconds. */
  helpDefaultTimeoutSeconds: await loadFromEnvIfSet(
    "HELP_DEFAULT_TIMEOUT_SECONDS",
    86_400,
  ),
  /** How often `help:expire` runs. */
  helpExpireFrequencyMs: await loadFromEnvIfSet(
    "HELP_EXPIRE_FREQUENCY_MS",
    60_000,
  ),
  /** The window the per-participant and per-channel limits count in. */
  rateWindowSeconds: await loadFromEnvIfSet("PLATFORM_RATE_WINDOW_SECONDS", 60),
  /** Slack: the Web API, where its OAuth sends a person, and its limits. */
  slack: {
    /** The Web API's base URL; the test suite points it at the Slack fake. */
    apiUrl: await loadFromEnvIfSet("SLACK_API_URL", "https://slack.com/api"),
    /** Where a person approves an install (`oauth/v2/authorize`). */
    authorizeUrl: await loadFromEnvIfSet(
      "SLACK_AUTHORIZE_URL",
      "https://slack.com/oauth/v2/authorize",
    ),
    /** How long one Web API call may take. */
    requestTimeoutMs: await loadFromEnvIfSet(
      "SLACK_REQUEST_TIMEOUT_MS",
      10_000,
    ),
    /** The per-installation token bucket: its size… */
    bucketCapacity: await loadFromEnvIfSet("SLACK_BUCKET_CAPACITY", 20),
    /** …and how many calls it refills each second (Slack's Tier 3 is ~50/min). */
    bucketRefillPerSecond: await loadFromEnvIfSet(
      "SLACK_BUCKET_REFILL_PER_SECOND",
      1,
    ),
    /** How long an install link (its OAuth `state`) lives, in seconds. */
    installStateTtlSeconds: await loadFromEnvIfSet(
      "SLACK_INSTALL_STATE_TTL_SECONDS",
      600,
    ),
    /** A stream older than this is closed and a new one started (Slack's limit is 10 minutes). */
    streamMaxAgeMs: await loadFromEnvIfSet("SLACK_STREAM_MAX_AGE_MS", 540_000),
  },
  /** Linear: the GraphQL API, where its OAuth sends a person, and its limits. */
  linear: {
    /** The API origin (`/graphql`, `/oauth/token`); the test suite points it at finear. */
    apiUrl: await loadFromEnvIfSet("LINEAR_API_URL", "https://api.linear.app"),
    /** Where a person approves an install (`oauth/authorize`). */
    authorizeUrl: await loadFromEnvIfSet(
      "LINEAR_AUTHORIZE_URL",
      "https://linear.app/oauth/authorize",
    ),
    /** Where a person creates an app from a manifest (`?manifest=` pre-fills it). */
    appCreationUrl: await loadFromEnvIfSet(
      "LINEAR_APP_CREATION_URL",
      "https://linear.app/settings/api/applications/new",
    ),
    /** How far a delivery's signed `webhookTimestamp` may be from now. */
    timestampToleranceSeconds: await loadFromEnvIfSet(
      "LINEAR_TIMESTAMP_TOLERANCE_SECONDS",
      60,
    ),
    /** How long one API call may take. */
    requestTimeoutMs: await loadFromEnvIfSet(
      "LINEAR_REQUEST_TIMEOUT_MS",
      10_000,
    ),
    /** The per-installation token bucket: its size… */
    bucketCapacity: await loadFromEnvIfSet("LINEAR_BUCKET_CAPACITY", 30),
    /** …how many calls it refills each second (Linear allows 5,000 an hour per app user)… */
    bucketRefillPerSecond: await loadFromEnvIfSet(
      "LINEAR_BUCKET_REFILL_PER_SECOND",
      1,
    ),
    /** …and how many tokens only acknowledgements and stops may take. */
    bucketReserve: await loadFromEnvIfSet("LINEAR_BUCKET_RESERVE", 5),
    /** Refresh an access token this long before it expires (Linear's last 24 hours). */
    refreshBeforeMs: await loadFromEnvIfSet(
      "LINEAR_REFRESH_BEFORE_MS",
      21_600_000,
    ),
    /** How long a refresh whose answer was lost may be retried with the old refresh token. */
    refreshReplayGraceMs: await loadFromEnvIfSet(
      "LINEAR_REFRESH_REPLAY_GRACE_MS",
      1_800_000,
    ),
    /** How often `installations:refresh-tokens` looks for tokens to refresh. */
    refreshFrequencyMs: await loadFromEnvIfSet(
      "LINEAR_REFRESH_FREQUENCY_MS",
      600_000,
    ),
  },
};

declare module "keryx" {
  interface KeryxConfig {
    platforms: typeof configPlatforms;
  }
}
