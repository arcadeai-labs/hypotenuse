import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { deliverSession } from "../../ops/ActivityOutboxOps";

/**
 * `activities:deliver` — send one session's pending outbound activities to
 * Linear, in order. Enqueued after anything is added to a session's outbox.
 * Only one process sends a session at a time (a Redis lease); a second job for
 * the same session finds it held and returns.
 *
 * Task-only, unaudited: it is the outbox draining, recorded on each row.
 */
export class ActivitiesDeliver implements Action {
  name = "activities:deliver";
  description =
    "Send one agent session's pending activities to Linear in order. Enqueued by the outbox; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "linear" };
  inputs = z.object({
    agentSessionId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The agent session whose outbox to send"),
  });

  /**
   * @param params - The session.
   * @returns What the run did.
   */
  async run(params: ActionParams<ActivitiesDeliver>) {
    return { delivery: await deliverSession(params.agentSessionId) };
  }
}
