import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import type {} from "../../config/platforms";
import {
  pendingTriggerEventIds,
  processTriggerEvent,
} from "../../ops/TriggerEventOps";

/**
 * `triggers:process-pending` — process the platform deliveries whose own job
 * was lost. A clock: task-only, never an HTTP route, and not audited.
 */
export class TriggersProcessPending implements Action {
  name = "triggers:process-pending";
  description =
    "Process platform deliveries that were missed. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.platforms.processPendingFrequencyMs,
  };
  inputs = z.object({});

  /** @returns How many were processed. */
  async run() {
    const ids = await pendingTriggerEventIds(config.agents.sweepBatchSize);
    let processed = 0;
    for (const id of ids) {
      if (await processTriggerEvent(id, false)) processed++;
    }
    return { pending: ids.length, processed };
  }
}
