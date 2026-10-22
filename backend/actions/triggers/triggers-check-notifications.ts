import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import {
  checkNotification,
  dueNotificationChecks,
  type NotificationCheck,
} from "../../ops/LinearNotificationOps";

/**
 * `triggers:check-notifications` — the clock that looks again at inbox
 * notifications whose handling needed a second look (`checkAfter`): whether
 * a mention started a session, and whether a status change closed an issue
 * with live work (`ops/LinearNotificationOps.ts`). Task-only, unaudited
 * machine ingress like `triggers:process-event`; never an MCP tool.
 */
export class TriggersCheckNotifications implements Action {
  name = "triggers:check-notifications";
  description =
    "Re-check Linear inbox notifications whose handling is due a second look. Runs automatically every few seconds; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "triggers", frequency: 10_000 };
  inputs = z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("The most notifications one tick checks"),
  });

  /**
   * @param params - The batch size.
   * @returns What each due check decided.
   */
  async run(params: ActionParams<TriggersCheckNotifications>) {
    const checked: { eventId: number; result: NotificationCheck }[] = [];
    for (const eventId of await dueNotificationChecks(
      new Date(),
      params.limit,
    )) {
      checked.push({ eventId, result: await checkNotification(eventId) });
    }
    return { checked };
  }
}
