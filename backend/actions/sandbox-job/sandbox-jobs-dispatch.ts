import { type Action, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import { dispatchPendingJobs } from "../../ops/SandboxJobOps";

/**
 * `sandbox-jobs:dispatch` — claim pending sandbox jobs, per project up to its
 * concurrency (and one per bot), and enqueue each one's `sandbox-job:start`.
 * A clock: task-only, never an HTTP route, unaudited. `sandbox_start` also
 * dispatches its own project at once, so this catches what that missed.
 */
export class SandboxJobsDispatch implements Action {
  name = "sandbox-jobs:dispatch";
  description =
    "Claim pending sandbox jobs and start them. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.sandbox.dispatchFrequencyMs,
  };
  inputs = z.object({});

  /** @returns The jobs claimed. */
  async run() {
    return { claimed: await dispatchPendingJobs() };
  }
}
