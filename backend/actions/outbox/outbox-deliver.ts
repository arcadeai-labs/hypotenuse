import type { Action, ActionParams } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { deliverConversation, deliverOutboxMessage } from "../../ops/OutboxOps";

/**
 * `outbox:deliver` — deliver one conversation's due outbox rows, in order,
 * under its delivery lease (or, given `outboxMessageId`, attempt that row).
 * Enqueued after the commit that writes rows. Not audited: the machine half
 * of a reply, recorded on `outbox_messages`.
 */
export class OutboxDeliver implements Action {
  name = "outbox:deliver";
  description =
    "Deliver a conversation's queued outbound messages. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "outbox" };
  inputs = z.object({
    conversationId: idInput("The conversation").optional(),
    outboxMessageId: idInput("One outbox row").optional(),
  });

  /**
   * @param params - The conversation, or one row.
   * @returns What was attempted.
   */
  async run(params: ActionParams<OutboxDeliver>) {
    if (params.conversationId) {
      return deliverConversation(params.conversationId);
    }
    if (params.outboxMessageId) {
      return {
        leased: false,
        outcomes: [await deliverOutboxMessage(params.outboxMessageId)],
      };
    }
    return { leased: false, outcomes: [] };
  }
}
