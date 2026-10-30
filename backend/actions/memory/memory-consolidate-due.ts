import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/memory";
import { conversationsOwed } from "../../ops/ConsolidationOps";

/**
 * `memory:consolidate-due` — enqueue a consolidation for every resting
 * conversation that is owed one and whose own enqueue was lost. A clock:
 * task-only, never an HTTP route, and not audited.
 */
export class MemoryConsolidateDue implements Action {
  name = "memory:consolidate-due";
  description =
    "Consolidate resting conversations whose consolidation was missed. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.memory.consolidateDueFrequencyMs,
  };
  inputs = z.object({});

  /** @returns The conversations enqueued. */
  async run() {
    const ids = await conversationsOwed();
    if (ids.length > 0) {
      await api.actions.fanOut(
        "memory:consolidate",
        ids.map((conversationId) => ({ conversationId })),
        "default",
      );
    }
    return { enqueued: ids };
  }
}
