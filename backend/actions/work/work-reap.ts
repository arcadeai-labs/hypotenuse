import { type Action, config } from "keryx";
import { z } from "zod";
import { publishRunnersChanged, reapOfflineRunners } from "../../ops/RunnerOps";

/**
 * `work:reap` — the presence clock: every runner whose last heartbeat is
 * older than `runners.offlineAfterMs` goes `offline`. Work routing adds lease
 * expiry to the same clock.
 *
 * Presence is heartbeats, never the socket: a daemon behind a proxy that eats
 * WebSockets still heartbeats and still works, and one whose socket is
 * attached but whose process is wedged stops heartbeating and goes offline.
 *
 * Task-only, never MCP, not audited (the schedule is not a person).
 */
export class WorkReap implements Action {
  name = "work:reap";
  description =
    "Mark runners whose heartbeat lapsed offline. Runs automatically; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default", frequency: config.runners.reapFrequencyMs };
  inputs = z.object({});

  /**
   * @returns How many runners went offline.
   */
  async run() {
    const reaped = await reapOfflineRunners();
    for (const projectId of new Set(reaped.map((r) => r.projectId))) {
      await publishRunnersChanged(projectId);
    }
    return { offline: reaped.map((r) => r.id) };
  }
}
