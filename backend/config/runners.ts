import { loadFromEnvIfSet } from "keryx";

/**
 * Runners: the daemons that run coding agents on people's machines.
 *
 * - `heartbeatIntervalMs` — how often a daemon heartbeats, chosen by the
 *   server and sent in every `daemon:connect` and `daemon:heartbeat` answer.
 * - `offlineAfterMs` — a runner with no heartbeat for this long is marked
 *   `offline` by `work:reap`: three missed beats.
 * - `leaseMs` — how long a claimed work item stays a runner's without a
 *   heartbeat or event renewing it; sent to the daemon now, enforced by work
 *   routing.
 * - `reapFrequencyMs` — how often the `work:reap` clock runs (presence, lapsed
 *   leases, and stops whose runner never confirmed).
 * - `routeFrequencyMs` — how often the `work:route` clock runs. Routing is
 *   also enqueued after anything that could make work placeable; the clock is
 *   the backstop.
 * - `keepaliveFrequencyMs` — how often `sessions:keepalive` looks for
 *   sessions waiting on Hypotenuse that have gone quiet.
 * - `rateLimit*` — per-runner request budgets, per minute. Loose on purpose:
 *   the daemon is ours, and the limit exists so a looping daemon costs one
 *   runner a 429 rather than the deployment its Linear budget. Enabled in
 *   tests (unlike the per-user limiter), because the per-runner key cannot
 *   collide across suites' users.
 */
export const configRunners = {
  heartbeatIntervalMs: await loadFromEnvIfSet(
    "RUNNER_HEARTBEAT_INTERVAL_MS",
    15_000,
  ),
  offlineAfterMs: await loadFromEnvIfSet("RUNNER_OFFLINE_AFTER_MS", 45_000),
  leaseMs: await loadFromEnvIfSet("RUNNER_LEASE_MS", 60_000),
  reapFrequencyMs: await loadFromEnvIfSet("RUNNER_REAP_FREQUENCY_MS", 15_000),
  routeFrequencyMs: await loadFromEnvIfSet("ROUTING_FREQUENCY_MS", 5_000),
  keepaliveFrequencyMs: await loadFromEnvIfSet(
    "ROUTING_KEEPALIVE_FREQUENCY_MS",
    60_000,
  ),
  rateLimitEnabled: await loadFromEnvIfSet("RUNNER_RATE_LIMIT_ENABLED", true),
  rateLimitWindowMs: await loadFromEnvIfSet(
    "RUNNER_RATE_LIMIT_WINDOW_MS",
    60_000,
  ),
  heartbeatLimit: await loadFromEnvIfSet("RUNNER_HEARTBEAT_LIMIT", 12),
  requestLimit: await loadFromEnvIfSet("RUNNER_REQUEST_LIMIT", 600),
  rateLimitKeyPrefix: "runner-ratelimit",
};

declare module "keryx" {
  interface KeryxConfig {
    runners: typeof configRunners;
  }
}
