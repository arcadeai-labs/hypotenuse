import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import { runTick } from "../../ops/TickOps";

/**
 * `agent:tick` — one tick of the agent loop for one conversation: claim the
 * lease, recover, deliver the inbox, take steps, and release. Task-only, on
 * the `agents` queue, with no timeout (a tick bounds itself and yields).
 *
 * Not audited: hundreds run per conversation, and the transcript
 * (`conversation_entries`) is the better record. The decisions behind it —
 * creating the bot, writing to it — are audited where a person made them.
 */
export class AgentTick implements Action {
  name = "agent:tick";
  description =
    "Run one tick of the agent loop for a conversation. Enqueued by the server; not exposed over HTTP.";
  mcp = { tool: false };
  timeout = 0;
  task = { queue: "agents" };
  inputs = z.object({
    conversationId: idInput("The conversation"),
    wake: z.coerce
      .number()
      .optional()
      .describe("The wakeRequestedAt (epoch ms) this tick was enqueued for"),
  });

  /**
   * @param params - The conversation, and the wake it was enqueued for.
   * @returns What the tick did.
   */
  async run(params: ActionParams<AgentTick>) {
    const result = await runTick(params.conversationId);
    if (result.claimed) {
      api.logger.info("agent tick", {
        conversationId: params.conversationId,
        steps: result.steps,
        ended: result.ended,
      });
    }
    return result;
  }
}
