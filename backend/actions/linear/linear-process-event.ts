import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import {
  afterProcessing,
  processLinearEvent,
} from "../../ops/LinearWebhookOps";

/**
 * `linear:process-event` — do what one recorded Linear webhook asks:
 * mirror the session, acknowledge it, record a prompt, apply a permission
 * change or a revocation. Enqueued by `webhooks:linear` for each new delivery,
 * on the `linear` queue that workers drain first.
 *
 * Task-only and unaudited: it is machine ingress, recorded in
 * `linear_events`. Safe to run twice for one event — the second run finds the
 * row processed and does nothing.
 */
export class LinearProcessEvent implements Action {
  name = "linear:process-event";
  description =
    "Process one recorded Linear webhook delivery. Enqueued by the webhook endpoint; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "linear" };
  inputs = z.object({
    eventId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The linear_events row to process"),
  });

  /**
   * @param params - The event id.
   * @returns The outcome, or `skipped` when it was already processed.
   */
  async run(params: ActionParams<LinearProcessEvent>) {
    const result = await processLinearEvent(params.eventId);
    if (!result) return { outcome: "skipped" as const };
    await afterProcessing(result);
    return { outcome: result.outcome };
  }
}
