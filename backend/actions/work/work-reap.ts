import { type Action, config } from "keryx";
import { z } from "zod";
import { publishRunnersChanged, reapOfflineRunners } from "../../ops/RunnerOps";
import { applyEffects, reapWork } from "../../ops/WorkItemOps";

/**
 * `work:reap` — the presence and lease clock:
 *
 * - every runner whose last heartbeat is older than `runners.offlineAfterMs`
 *   goes `offline`;
 * - every claimed turn whose lease lapsed goes back to the queue (sticky to
 *   its runner, `attempts + 1`), or fails after too many lapses;
 * - every stopped turn whose runner has not confirmed within the project's
 *   `stopGraceMs` is ended by the server, which tells the session so.
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
    "Mark runners whose heartbeat lapsed offline and return lapsed work to the queue. Runs automatically; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "routing", frequency: config.runners.reapFrequencyMs };
  inputs = z.object({});

  /**
   * @returns The runners that went offline and the turns reaped.
   */
  async run() {
    const reaped = await reapOfflineRunners();
    for (const projectId of new Set(reaped.map((r) => r.projectId))) {
      await publishRunnersChanged(projectId);
    }
    const work = await reapWork();
    if (reaped.length > 0) work.effects.route = true;
    await applyEffects(work.effects);
    return {
      offline: reaped.map((r) => r.id),
      requeued: work.requeued,
      failed: work.failed,
      stopped: work.stopped,
    };
  }
}
