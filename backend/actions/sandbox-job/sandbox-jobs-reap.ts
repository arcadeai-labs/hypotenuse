import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import { reapSandboxJobs } from "../../ops/SandboxReapOps";

/**
 * `sandbox-jobs:reap` — the reaper's six sweeps (dead supervisor, stalled
 * agent, stuck provisioning, over duration, cancel not acknowledged, idle
 * interactive), question expiry, and waking any conversation left waiting
 * on a job that ended. A clock: task-only, unaudited.
 */
export class SandboxJobsReap implements Action {
  name = "sandbox-jobs:reap";
  description =
    "End sandbox jobs that died, stalled, ran too long, or were abandoned. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.sandbox.reapFrequencyMs };
  timeout = 0;
  inputs = z.object({});

  /** @returns How many jobs each sweep ended. */
  async run() {
    return { reaped: await reapSandboxJobs() };
  }
}
