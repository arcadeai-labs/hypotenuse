import { type Action, config } from "keryx";
import { z } from "zod";
import { scheduleDelivery } from "../../ops/ActivityOutboxOps";
import { keepaliveSessions } from "../../ops/WorkRouteOps";

/**
 * `sessions:keepalive` — Linear marks a session `stale` after 30 minutes
 * without an activity. A session waiting **on Hypotenuse** (a turn queued for
 * a runner) that has been quiet for 25 minutes gets an ephemeral thought
 * saying what it waits for. One waiting on a **person** is left alone. The
 * daemon keeps its own running turns alive.
 *
 * Task-only, never MCP, not audited (the schedule is not a person).
 */
export class SessionsKeepalive implements Action {
  name = "sessions:keepalive";
  description =
    "Keep sessions waiting for a runner from going stale in Linear. Runs automatically; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "routing", frequency: config.runners.keepaliveFrequencyMs };
  inputs = z.object({});

  /**
   * @returns The sessions kept alive.
   */
  async run() {
    const kept = await keepaliveSessions();
    await scheduleDelivery(kept);
    return { kept };
  }
}
