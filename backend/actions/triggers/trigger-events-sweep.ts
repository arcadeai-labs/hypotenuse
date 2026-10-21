import { lt } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
import { triggerEvents } from "../../schema/trigger_events";

/**
 * `trigger-events:sweep` — a daily clock deleting recorded webhook deliveries
 * older than `LINEAR_EVENT_RETENTION_DAYS`. The session mirror is the record;
 * these rows are for dedupe and debugging. Task-only, unaudited.
 */
export class TriggerEventsSweep implements Action {
  name = "trigger-events:sweep";
  description =
    "Delete recorded trigger webhook deliveries older than the retention period. Runs automatically once per day; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default", frequency: 1000 * 60 * 60 * 24 };
  inputs = z.object({});

  /**
   * @returns How many deliveries were deleted.
   */
  async run() {
    const cutoff = new Date(
      Date.now() - config.linear.eventRetentionDays * 24 * 60 * 60 * 1000,
    );
    const deleted = await api.db.db
      .delete(triggerEvents)
      .where(lt(triggerEvents.receivedAt, cutoff))
      .returning({ id: triggerEvents.id });
    return { deleted: deleted.length };
  }
}
