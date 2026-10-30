import { loadFromEnvIfSet } from "keryx";

/**
 * The agent loop: how long a tick may hold a conversation, how much one tick
 * may do before yielding its worker, when compaction runs, and how often the
 * clocks that sweep up lost work fire. Every value is read at use, so a suite
 * may change one for a test and put it back.
 */
export const configAgents = {
  /** How long a claimed lease lasts; every commit extends it. */
  leaseMs: await loadFromEnvIfSet("AGENT_LEASE_MS", 90_000),
  /** How often a tick re-checks its lease and the cancel flag while a model call or tool runs. */
  heartbeatMs: await loadFromEnvIfSet("AGENT_HEARTBEAT_MS", 1_000),
  /** Model steps one tick takes before yielding the worker to other conversations. */
  maxStepsPerTick: await loadFromEnvIfSet("AGENT_MAX_STEPS_PER_TICK", 8),
  /** Wall-clock budget of one tick before it yields, in milliseconds. */
  tickBudgetMs: await loadFromEnvIfSet("AGENT_TICK_BUDGET_MS", 60_000),
  /** Attempts at one model step when the provider fails transiently (429, 5xx, a dropped stream). */
  modelAttempts: await loadFromEnvIfSet("AGENT_MODEL_ATTEMPTS", 3),
  /** The first back-off between model attempts, doubled each time. */
  modelRetryBaseMs: await loadFromEnvIfSet("AGENT_MODEL_RETRY_BASE_MS", 500),
  /** The context window assumed for every model, in tokens. */
  contextWindowTokens: await loadFromEnvIfSet(
    "AGENT_CONTEXT_WINDOW_TOKENS",
    200_000,
  ),
  /** Compact in the background once a step's prompt comes within this many tokens of the window. */
  compactBackgroundTokens: await loadFromEnvIfSet(
    "AGENT_COMPACT_BACKGROUND_TOKENS",
    32_768,
  ),
  /** A tick waits for a running compaction only when less than this is left of the window. */
  compactReserveTokens: await loadFromEnvIfSet(
    "AGENT_COMPACT_RESERVE_TOKENS",
    16_384,
  ),
  /** How long a tick waits before re-checking on a compaction it must wait for. */
  compactWaitMs: await loadFromEnvIfSet("AGENT_COMPACT_WAIT_MS", 2_000),
  /** How often `agents:reap` looks for expired leases. */
  reapFrequencyMs: await loadFromEnvIfSet("AGENT_REAP_FREQUENCY_MS", 15_000),
  /** How often `agents:wake-due` looks for owed ticks, due timers, and timed-out questions. */
  wakeDueFrequencyMs: await loadFromEnvIfSet(
    "AGENT_WAKE_DUE_FREQUENCY_MS",
    5_000,
  ),
  /** How old an unclaimed wake must be before `agents:wake-due` re-enqueues its tick. */
  wakeStaleMs: await loadFromEnvIfSet("AGENT_WAKE_STALE_MS", 10_000),
  /** How many conversations one clock run handles. */
  sweepBatchSize: await loadFromEnvIfSet("AGENT_SWEEP_BATCH", 100),
  /** How often `outbox:deliver-due` retries what is due. */
  outboxFrequencyMs: await loadFromEnvIfSet("OUTBOX_FREQUENCY_MS", 1_000),
  /** How long an outbox row is retried before it is `undeliverable`. */
  outboxRetryWindowMs: await loadFromEnvIfSet(
    "OUTBOX_RETRY_WINDOW_MS",
    24 * 60 * 60 * 1000,
  ),
  /** The first back-off between delivery attempts, doubled each time, capped at an hour. */
  outboxRetryBaseMs: await loadFromEnvIfSet("OUTBOX_RETRY_BASE_MS", 10_000),
  /** How long one callback POST may take. */
  callbackTimeoutMs: await loadFromEnvIfSet(
    "OUTBOX_CALLBACK_TIMEOUT_MS",
    10_000,
  ),
};

declare module "keryx" {
  interface KeryxConfig {
    agents: typeof configAgents;
  }
}
