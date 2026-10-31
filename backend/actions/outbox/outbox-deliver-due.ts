import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import type {} from "../../config/platforms";
import { deliverConversation, dueConversationIds } from "../../ops/OutboxOps";

/**
 * `outbox:deliver-due` — deliver every conversation with a due outbox row,
 * a few conversations at a time, each in order under its own lease. A clock:
 * task-only, never an HTTP route, and not audited.
 */
export class OutboxDeliverDue implements Action {
  name = "outbox:deliver-due";
  description =
    "Retry outbound messages that are due. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "outbox", frequency: config.agents.outboxFrequencyMs };
  inputs = z.object({});

  /** @returns How many rows were attempted, by outcome. */
  async run() {
    const ids = await dueConversationIds(config.agents.sweepBatchSize);
    const outcomes: Record<string, number> = {};
    let attempted = 0;
    const width = Math.max(1, config.platforms.deliverConcurrency);
    for (let i = 0; i < ids.length; i += width) {
      const batch = await Promise.all(
        ids.slice(i, i + width).map((id) => deliverConversation(id)),
      );
      for (const b of batch) {
        for (const o of b.outcomes) {
          attempted++;
          outcomes[o] = (outcomes[o] ?? 0) + 1;
        }
      }
    }
    return { conversations: ids.length, attempted, outcomes };
  }
}
