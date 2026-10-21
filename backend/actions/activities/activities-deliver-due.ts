import { type Action } from "keryx";
import { z } from "zod";
import {
  deliverSession,
  sessionsWithDueRows,
} from "../../ops/ActivityOutboxOps";

/** How many sessions one tick sends at once. */
const CONCURRENCY = 8;

/**
 * `activities:deliver-due` — the outbox's clock. Every second, send every
 * session with a row due: one whose enqueue was lost, or whose backoff, budget
 * wait, or rate-limit reset has passed. Sessions run in parallel, each in
 * order. Task-only, unaudited, never an MCP tool.
 */
export class ActivitiesDeliverDue implements Action {
  name = "activities:deliver-due";
  description =
    "Send every agent session's due activities to Linear. Runs automatically every second; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "linear", frequency: 1000 };
  inputs = z.object({});

  /**
   * @returns How many sessions were sent, and how many activities.
   */
  async run() {
    const due = await sessionsWithDueRows();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      const runs = await Promise.all(
        due.slice(i, i + CONCURRENCY).map((id) => deliverSession(id)),
      );
      for (const run of runs) {
        sent += run.sent;
        failed += run.failed;
      }
    }
    return { sessions: due.length, sent, failed };
  }
}
