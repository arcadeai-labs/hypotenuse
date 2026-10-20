import { lt } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/notifications";
import { notifications } from "../../schema/notifications";

/**
 * `notifications:sweep` — drop notifications past the retention window.
 *
 * The row goes entirely: a notification is a message, not a record of what a
 * project did, and the thing it was about has its own durable row that
 * outlives this one. Keeping a
 * month-old "you have an unread notification" forever would make the bell's
 * count a measure of how long the account has existed.
 *
 * Age is measured from `createdAt` rather than `sentAt`, so a row that could
 * never be delivered is collected on the same schedule as one that was.
 *
 * A plain `Action`, like every other retention sweep.
 */
export class NotificationsSweep implements Action {
  name = "notifications:sweep";
  description =
    "Delete notifications older than the retention window, read or not. Runs automatically once a day; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: 24 * 60 * 60 * 1000 };
  inputs = z.object({});

  /**
   * Delete everything past the retention cutoff.
   * @returns How many rows were deleted.
   */
  async run() {
    const cutoff = new Date(
      Date.now() - config.notifications.retentionDays * 24 * 60 * 60 * 1000,
    );

    const deleted = await api.db.db
      .delete(notifications)
      .where(lt(notifications.createdAt, cutoff))
      .returning({ id: notifications.id });

    if (deleted.length > 0) {
      api.logger.info("purged expired notifications", {
        deleted: deleted.length,
      });
    }

    return { deleted: deleted.length };
  }
}
