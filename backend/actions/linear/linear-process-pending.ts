import { and, asc, isNull, lt } from "drizzle-orm";
import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import {
  afterProcessing,
  processLinearEvent,
} from "../../ops/LinearWebhookOps";
import { linearEvents } from "../../schema/linear_events";

/** A delivery younger than this is left to the job its webhook enqueued. */
const GRACE_MS = 2000;

/** The most events one tick processes. */
const BATCH = 100;

/**
 * `linear:process-pending` — the clock behind the webhook's enqueue. Every
 * five seconds, process any recorded delivery still unprocessed: the job for
 * it was lost (Redis restarted, a worker died mid-job), and the row is the
 * delivery. Task-only, unaudited, never an MCP tool.
 */
export class LinearProcessPending implements Action {
  name = "linear:process-pending";
  description =
    "Process Linear webhook deliveries whose processing job was lost. Runs automatically every few seconds; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "linear", frequency: 5000 };
  inputs = z.object({
    graceMs: z.coerce
      .number()
      .int()
      .min(0)
      .default(GRACE_MS)
      .describe("Leave deliveries younger than this to their own job"),
  });

  /**
   * @param params - The grace period.
   * @returns How many deliveries this tick processed.
   */
  async run(params: ActionParams<LinearProcessPending>) {
    const due = await api.db.db
      .select({ id: linearEvents.id })
      .from(linearEvents)
      .where(
        and(
          isNull(linearEvents.processedAt),
          lt(linearEvents.receivedAt, new Date(Date.now() - params.graceMs)),
        ),
      )
      .orderBy(asc(linearEvents.id))
      .limit(BATCH);

    let processed = 0;
    for (const { id } of due) {
      const result = await processLinearEvent(id);
      if (!result) continue;
      processed++;
      await afterProcessing(result);
    }
    return { processed };
  }
}
