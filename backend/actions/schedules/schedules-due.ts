import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/schedules";
import { claimDue, enqueueFires, staleRuns } from "../../ops/ScheduleOps";

/**
 * `schedules:due` — claim schedules whose next slot has passed, write one
 * run per slot, advance them, and fire the runs; and fire again any run a
 * lost task left `pending` or `guarding`. A clock: task-only, never an HTTP
 * route, and not audited.
 */
export class SchedulesDue implements Action {
  name = "schedules:due";
  description =
    "Write a run for each schedule whose slot has passed and fire it, and re-fire runs a lost task left behind. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.schedules.dueFrequencyMs,
  };
  inputs = z.object({});

  /** @returns The runs written and the stale runs fired again. */
  async run() {
    const claimed = await claimDue();
    const stale = (await staleRuns()).filter((id) => !claimed.includes(id));
    await enqueueFires([...claimed, ...stale]);
    return { claimed: claimed.length, refired: stale.length };
  }
}
