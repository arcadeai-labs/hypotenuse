import { loadFromEnvIfSet } from "keryx";

/**
 * Sandboxes: where a bot's code work runs, and the clocks that watch it. Read
 * at use, so a suite may change one for a test and put it back.
 *
 * `defaultProvider` is `docker` because that is the local inner loop. The
 * deployed blueprint names another, and `assertSandboxProviderAllowed` refuses
 * `docker` outright in production, so a missing override fails loudly rather
 * than running containers on a web dyno.
 */
export const configSandbox = {
  /** The provider a project gets until an admin picks one. */
  defaultProvider: await loadFromEnvIfSet(
    "SANDBOX_DEFAULT_PROVIDER",
    "docker" as string,
  ),
  /** The image the `docker` provider runs when a project names none. */
  dockerImage: await loadFromEnvIfSet(
    "SANDBOX_DOCKER_IMAGE",
    "hypotenuse/sandbox:dev",
  ),
  /**
   * The Docker network a `docker` sandbox joins; empty for Docker's default
   * bridge. `host` puts it on the host's network, so it reaches a server
   * bound to loopback — what the test suite uses, on Linux.
   */
  dockerNetwork: await loadFromEnvIfSet("SANDBOX_DOCKER_NETWORK", ""),
  /**
   * The base URL a sandbox reaches this server on. Empty means the web
   * server's own URL, with a loopback host rewritten for `docker`.
   */
  apiUrl: await loadFromEnvIfSet("SANDBOX_API_URL", ""),
  /** Jobs in flight per project, unless the project sets its own. */
  defaultConcurrency: await loadFromEnvIfSet("SANDBOX_DEFAULT_CONCURRENCY", 3),
  /** Jobs in flight per bot. */
  perBotConcurrency: await loadFromEnvIfSet("SANDBOX_PER_BOT_CONCURRENCY", 1),
  /** A job's hard ceiling, unless the project sets a lower one. */
  maxDurationMs: await loadFromEnvIfSet(
    "SANDBOX_MAX_DURATION_MS",
    60 * 60 * 1000,
  ),
  /** How long an interactive job may sit `awaiting_input` before it expires. */
  idleTimeoutMs: await loadFromEnvIfSet(
    "SANDBOX_IDLE_TIMEOUT_MS",
    30 * 60 * 1000,
  ),
  /** How often `sandbox-jobs:dispatch` claims pending jobs. */
  dispatchFrequencyMs: await loadFromEnvIfSet(
    "SANDBOX_DISPATCH_FREQUENCY_MS",
    10_000,
  ),
  /** How often `sandbox-jobs:reap` sweeps. */
  reapFrequencyMs: await loadFromEnvIfSet("SANDBOX_REAP_FREQUENCY_MS", 30_000),
  /** How often `sandbox:orphan-sweep` runs. */
  orphanFrequencyMs: await loadFromEnvIfSet(
    "SANDBOX_ORPHAN_FREQUENCY_MS",
    5 * 60 * 1000,
  ),
  /** Supervisor heartbeat older than this: the supervisor is dead. */
  heartbeatStaleMs: await loadFromEnvIfSet(
    "SANDBOX_HEARTBEAT_STALE_MS",
    3 * 60 * 1000,
  ),
  /** No event, ask, or status for this long: the agent has stalled. */
  activityStaleMs: await loadFromEnvIfSet(
    "SANDBOX_ACTIVITY_STALE_MS",
    15 * 60 * 1000,
  ),
  /** A job still `provisioning` after this long is stuck. */
  provisioningStaleMs: await loadFromEnvIfSet(
    "SANDBOX_PROVISIONING_STALE_MS",
    10 * 60 * 1000,
  ),
  /** A cancel the supervisor has not acknowledged after this long is forced. */
  cancelGraceMs: await loadFromEnvIfSet("SANDBOX_CANCEL_GRACE_MS", 60_000),
  /** How long a ledger row may be unattached before the orphan sweep collects it. */
  orphanGraceMs: await loadFromEnvIfSet(
    "SANDBOX_ORPHAN_GRACE_MS",
    15 * 60 * 1000,
  ),
  /** Supervisor requests per job per window (`sandbox:events`, heartbeats, tools). */
  supervisorRateLimit: await loadFromEnvIfSet(
    "SANDBOX_SUPERVISOR_RATE_LIMIT",
    300,
  ),
  /** The window {@link configSandbox.supervisorRateLimit} counts over. */
  supervisorRateWindowMs: await loadFromEnvIfSet(
    "SANDBOX_SUPERVISOR_RATE_WINDOW_MS",
    60_000,
  ),
  /** Questions one job may ask, counted under the job's row lock. */
  questionCap: await loadFromEnvIfSet("SANDBOX_QUESTION_CAP", 5),
  /** How long a sandbox question stays open. */
  questionTimeoutMs: await loadFromEnvIfSet(
    "SANDBOX_QUESTION_TIMEOUT_MS",
    24 * 60 * 60 * 1000,
  ),
  /** The longest one `sandbox-check-answer` call waits. */
  maxCheckWaitMs: await loadFromEnvIfSet("SANDBOX_MAX_CHECK_WAIT_MS", 25_000),
  /** The heartbeat interval written into the supervisor's environment. */
  heartbeatMs: await loadFromEnvIfSet("SANDBOX_HEARTBEAT_MS", 30_000),
};

declare module "keryx" {
  interface KeryxConfig {
    sandbox: typeof configSandbox;
  }
}
