import { loadFromEnvIfSet } from "keryx";

/**
 * Schedules: how often the clock looks for due slots, how late a slot may
 * fire, the limits a schedule is held to, and when a run nobody fired is
 * fired again. Every value is read at use, so a suite may change one for a
 * test and put it back.
 */
export const configSchedules = {
  /** How often `schedules:due` looks for schedules whose next slot has passed. */
  dueFrequencyMs: await loadFromEnvIfSet("SCHEDULES_DUE_FREQUENCY_MS", 30_000),
  /**
   * How late a slot may be and still count as on time. With `catchUp: none`,
   * a slot later than this is dropped; with `latest`, only the newest missed
   * slot runs.
   */
  lateGraceMs: await loadFromEnvIfSet("SCHEDULES_LATE_GRACE_MS", 5 * 60_000),
  /** The shortest gap between two slots of one schedule. */
  minIntervalMs: await loadFromEnvIfSet(
    "SCHEDULES_MIN_INTERVAL_MS",
    5 * 60_000,
  ),
  /** How many schedules a bot may have, proposed ones included. */
  maxPerBot: await loadFromEnvIfSet("SCHEDULES_MAX_PER_BOT", 10),
  /** A run still `pending` or `guarding` after this long is fired again. */
  staleRunMs: await loadFromEnvIfSet("SCHEDULES_STALE_RUN_MS", 2 * 60_000),
  /** How many schedules one clock run claims. */
  batchSize: await loadFromEnvIfSet("SCHEDULES_BATCH", 100),
};

declare module "keryx" {
  interface KeryxConfig {
    schedules: typeof configSchedules;
  }
}
