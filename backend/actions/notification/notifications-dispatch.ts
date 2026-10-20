import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/notifications";
import {
  claimDueNotifications,
  deliverNotification,
} from "../../ops/NotificationOps";

/**
 * `notifications:dispatch` — deliver what is queued.
 *
 * The other half of "notifications are a table, not a direct send": whatever
 * raised the notification returned the moment the row was written, and this is
 * where the SMTP handshake and the broadcast actually happen. A mail server
 * being down therefore costs a retry here instead of failing whatever raised
 * the notification minutes earlier.
 *
 * Claims with `FOR UPDATE SKIP LOCKED`, so two overlapping ticks partition the backlog rather than both sending the same
 * message. The batch is capped so a large backlog cannot monopolize a tick — the
 * next one picks up where this left off, and the ordering is by `nextAttemptAt`
 * so a retry never starves behind newer work.
 *
 * A plain `Action`: the clock delivering queued mail is not somebody's decision.
 */
export class NotificationsDispatch implements Action {
  name = "notifications:dispatch";
  description =
    "Deliver queued notifications: broadcast the browser ones and send the email ones, with exponential backoff on failure. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.notifications.dispatchFrequencyMs,
  };
  inputs = z.object({});

  /**
   * Claim and deliver one batch.
   * @returns How many rows were claimed, and whether the batch was full — a full
   *   batch means there is more waiting, which is worth seeing in a log.
   */
  async run() {
    const limit = config.notifications.dispatchBatchSize;
    const claimed = await claimDueNotifications(limit);

    if (claimed.length === 0) return { delivered: 0, truncated: false };

    // Sequential rather than concurrent, deliberately: an SMTP transport pools
    // its own connections and a burst of parallel sends is the fastest way to
    // get a mail provider to rate-limit the whole account. A batch of a hundred
    // is seconds either way.
    for (const row of claimed) {
      await deliverNotification(row);
    }

    api.logger.info("dispatched notifications", { delivered: claimed.length });

    return { delivered: claimed.length, truncated: claimed.length >= limit };
  }
}
