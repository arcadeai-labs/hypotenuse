import { and, asc, isNull, sql } from "drizzle-orm";
import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import {
  afterProcessing,
  processTriggerEvent,
} from "../../ops/TriggerEventOps";
import { triggerEvents } from "../../schema/trigger_events";

/** A delivery younger than this is left to the job its webhook enqueued. */
const GRACE_MS = 2000;

/** The most events one tick processes. */
const BATCH = 100;

/**
 * `triggers:process-pending` — the clock behind the webhook's enqueue. Every
 * five seconds, process any recorded delivery still unprocessed: the job for
 * it was lost (Redis restarted, a worker died mid-job), and the row is the
 * delivery. Task-only, unaudited, never an MCP tool.
 */
export class TriggersProcessPending implements Action {
  name = "triggers:process-pending";
  description =
    "Process trigger webhook deliveries whose processing job was lost. Runs automatically every few seconds; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "triggers", frequency: 5000 };
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
  async run(params: ActionParams<TriggersProcessPending>) {
    const due = await api.db.db
      .select({ id: triggerEvents.id })
      .from(triggerEvents)
      .where(
        and(
          isNull(triggerEvents.processedAt),
          // Postgres's clock on both sides: `received_at` is its `now()`, in
          // microseconds, and a cutoff from this process's milliseconds put a
          // delivery made in the same millisecond after it.
          sql`${triggerEvents.receivedAt} <= now() - make_interval(secs => ${params.graceMs / 1000})`,
        ),
      )
      .orderBy(asc(triggerEvents.id))
      .limit(BATCH);

    let processed = 0;
    for (const { id } of due) {
      const result = await processTriggerEvent(id);
      if (!result) continue;
      processed++;
      await afterProcessing(result);
    }
    return { processed };
  }
}
