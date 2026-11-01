import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import { sweepOrphans } from "../../ops/SandboxReapOps";

/**
 * `sandbox:orphan-sweep` — destroy provider sandboxes with no live ledger
 * row, and ledger rows with no live job. A clock: task-only, unaudited.
 */
export class SandboxOrphanSweep implements Action {
  name = "sandbox:orphan-sweep";
  description =
    "Destroy leaked sandboxes. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.sandbox.orphanFrequencyMs };
  timeout = 0;
  inputs = z.object({});

  /** @returns How many were destroyed. */
  async run() {
    return await sweepOrphans();
  }
}
