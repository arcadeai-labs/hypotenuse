import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import { consolidateConversation } from "../../ops/ConsolidationOps";
import { idInput } from "../../ops/InputOps";

/**
 * `memory:consolidate` — after a conversation comes to rest, its bot's `fast`
 * model writes the durable facts it heard into channel memory, each citing
 * the entries it came from. Task-only. Not audited: machine work whose record
 * is each version's `sourceRef` and the conversation's consolidation mark.
 */
export class MemoryConsolidate implements Action {
  name = "memory:consolidate";
  description =
    "Write the facts from a resting conversation into its channel's memory. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "default" };
  inputs = z.object({ conversationId: idInput("The conversation") });

  /**
   * @param params - The conversation.
   * @returns The paths written, or `null` when nothing was owed.
   */
  async run(params: ActionParams<MemoryConsolidate>) {
    const result = await consolidateConversation(params.conversationId);
    if (result) {
      api.logger.info("memory consolidated", {
        conversationId: params.conversationId,
        facts: result.written.length,
      });
    }
    return { result };
  }
}
