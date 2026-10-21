import { type Action, config } from "keryx";
import { z } from "zod";
import { applyEffects } from "../../ops/WorkItemOps";
import { routeWork } from "../../ops/WorkRouteOps";

/**
 * `work:route` — one routing pass: lapsed offers go back to the queue,
 * sessions with unprepared turns are prepared (the issue read, the role and
 * repository chosen), and each session's next queued turn is offered to the
 * best eligible runner, which is pinged on `runner:<id>`.
 *
 * Enqueued after anything that could make work placeable — a new turn, a
 * completion, a heartbeat that changed presence or capacity, a revocation —
 * and run as a clock as the backstop. The server never pushes work: the ping
 * makes the runner heartbeat, and the runner claims.
 *
 * Task-only, never MCP, not audited (the schedule is not a person).
 */
export class WorkRoute implements Action {
  name = "work:route";
  description =
    "Place queued work on runners. Runs automatically; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "routing", frequency: config.runners.routeFrequencyMs };
  inputs = z.object({});

  /**
   * @returns What the pass did.
   */
  async run() {
    const result = await routeWork();
    await applyEffects(result.effects);
    return {
      ran: result.ran,
      lapsed: result.lapsed,
      prepared: result.prepared,
      offered: result.offered,
    };
  }
}
