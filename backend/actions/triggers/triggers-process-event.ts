import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import {
  afterProcessing,
  processTriggerEvent,
} from "../../ops/TriggerEventOps";

/**
 * `triggers:process-event` — do what one recorded trigger webhook asks (today
 * Linear's):
 * mirror the session, acknowledge it, record a prompt, apply a permission
 * change or a revocation. Enqueued by `webhooks:linear` for each new delivery,
 * on the `triggers` queue that workers drain first.
 *
 * Task-only and unaudited: it is machine ingress, recorded in
 * `trigger_events`. Safe to run twice for one event — the second run finds the
 * row processed and does nothing.
 */
export class TriggersProcessEvent implements Action {
  name = "triggers:process-event";
  description =
    "Process one recorded trigger webhook delivery. Enqueued by the webhook endpoint; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "triggers" };
  inputs = z.object({
    eventId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The trigger_events row to process"),
  });

  /**
   * @param params - The event id.
   * @returns The outcome, or `skipped` when it was already processed.
   */
  async run(params: ActionParams<TriggersProcessEvent>) {
    const result = await processTriggerEvent(params.eventId);
    if (!result) return { outcome: "skipped" as const };
    await afterProcessing(result);
    return { outcome: result.outcome };
  }
}
