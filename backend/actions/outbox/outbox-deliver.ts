import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { deliverOutboxMessage } from "../../ops/OutboxOps";

/**
 * `outbox:deliver` — attempt one outbox row: POST a signed callback. Enqueued
 * after the step that wrote the row commits. Not audited: the machine half of
 * a reply, recorded on `outbox_messages`.
 */
export class OutboxDeliver implements Action {
  name = "outbox:deliver";
  description =
    "Deliver one queued outbound message. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "outbox" };
  inputs = z.object({ outboxMessageId: idInput("The outbox row") });

  /**
   * @param params - The row.
   * @returns What the attempt did.
   */
  async run(params: ActionParams<OutboxDeliver>) {
    const outcome = await deliverOutboxMessage(params.outboxMessageId);
    return { outcome };
  }
}
