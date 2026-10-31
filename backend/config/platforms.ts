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
};

declare module "keryx" {
  interface KeryxConfig {
    platforms: typeof configPlatforms;
  }
}
