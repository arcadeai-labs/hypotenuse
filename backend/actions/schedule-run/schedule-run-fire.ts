import type { Action, ActionParams } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { fireRun } from "../../ops/ScheduleOps";

/**
 * `schedule-run:fire` — fire one schedule run: check its target, ask its
 * guard, and wake the bot. A per-run task enqueued by `schedules:due` and
 * `schedule:run-now`; never an HTTP route, never a clock, and not audited
 * (recorded on the run).
 */
export class ScheduleRunFire implements Action {
  name = "schedule-run:fire";
  description =
    "Fire one schedule run: check the target is still engaged, ask the guard, and wake the bot. Enqueued by the schedule clock; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "agents" };
  inputs = z.object({ runId: idInput("The run") });

  /**
   * @param params - The run.
   * @returns What the fire did.
   */
  async run(params: ActionParams<ScheduleRunFire>) {
    return { outcome: await fireRun(params.runId) };
  }
}
