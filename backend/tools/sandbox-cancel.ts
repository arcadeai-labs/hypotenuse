import { z } from "zod";
import { isTerminalJobStatus, requestJobCancel } from "../ops/SandboxJobOps";
import { conversationJob, hasJobs } from "./sandbox-shared";
import type { ToolDefinition } from "./types";

const input = z.object({
  jobId: z.number().int().positive().describe("The job to stop"),
});

const output = z.object({ status: z.string(), note: z.string() });

/**
 * `sandbox_cancel` — stop a job of this conversation. Replay safe: a cancel
 * asked twice is one cancel.
 */
export const sandboxCancel: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_cancel",
  description:
    "Stop a sandbox job this conversation started, when its work is no longer wanted. It stops within a heartbeat; you are told when it has.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: false,
  available: (ctx) => hasJobs(ctx),
  run: async (args, ctx) => {
    const job = await conversationJob(ctx, args.jobId);
    if (isTerminalJobStatus(job.status)) {
      return { status: job.status, note: "It had already ended." };
    }
    const after = await requestJobCancel(job.id, "bot");
    return {
      status: after.status,
      note:
        after.status === "cancelled"
          ? "Cancelled before it started."
          : "Asked to stop; you will be told when it has.",
    };
  },
};
