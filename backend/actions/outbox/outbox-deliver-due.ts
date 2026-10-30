import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import { deliverOutboxMessage, dueOutboxIds } from "../../ops/OutboxOps";

/**
 * `outbox:deliver-due` — attempt every outbox row that is due: never tried,
 * backed off long enough, or stuck past its claim. A clock: task-only, never
 * an HTTP route, and not audited.
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
    const ids = await dueOutboxIds(config.agents.sweepBatchSize);
    const outcomes: Record<string, number> = {};
    for (const id of ids) {
      const outcome = await deliverOutboxMessage(id);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { attempted: ids.length, outcomes };
  }
}
