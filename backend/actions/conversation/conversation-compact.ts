import { type Action, type ActionParams } from "keryx";
import { z } from "zod";
import { compactConversation } from "../../ops/CompactionOps";
import { idInput } from "../../ops/InputOps";

/**
 * `conversation:compact` — summarize a conversation's older turns into a
 * `compaction` entry with the bot's `fast` model. Task-only; runs beside the
 * conversation and takes no lease. Not audited: machine work whose record is
 * the entry it writes.
 */
export class ConversationCompact implements Action {
  name = "conversation:compact";
  description =
    "Summarize a conversation's earlier turns in the background. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "agents" };
  inputs = z.object({ conversationId: idInput("The conversation") });

  /**
   * @param params - The conversation.
   * @returns The seq summarized through, or `null` when there was nothing to do.
   */
  async run(params: ActionParams<ConversationCompact>) {
    const throughSeq = await compactConversation(params.conversationId);
    return { throughSeq };
  }
}
