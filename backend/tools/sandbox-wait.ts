import { z } from "zod";
import { isTerminalJobStatus } from "../ops/SandboxJobOps";
import {
  conversationJob,
  hasJobs,
  latestConversationJobId,
} from "./sandbox-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  jobId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The job to wait for; omit for the one this conversation started last",
    ),
});

const output = z.object({ jobId: z.number(), note: z.string() });

/**
 * `sandbox_wait` — end the turn waiting on a sandbox job of this
 * conversation: `waiting` / `sandbox` until the job ends, asks a blocking
 * question, or finishes an interactive turn (each wakes it), or a person
 * writes here. Replay safe: deciding to wait changes nothing outside the
 * conversation, and a job that already ended is refused, so the
 * conversation never waits on a dead job.
 */
export const sandboxWait: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_wait",
  description:
    "End your turn and wait for a sandbox job this conversation started. You wake when it finishes (its result arrives as a message), when it asks you a question, or when someone here writes.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: false,
  terminal: (out) => ({
    to: "waiting",
    waitingOn: { kind: "sandbox", sandboxJobId: out.jobId },
  }),
  available: (ctx) => hasJobs(ctx),
  run: async (args, ctx) => {
    const job = await conversationJob(
      ctx,
      args.jobId ?? (await latestConversationJobId(ctx)),
    );
    if (isTerminalJobStatus(job.status)) {
      throw new ToolError(
        "job_ended",
        `Sandbox job ${job.id} already ended (${job.status.replace("_", " ")}); its result is in your messages.`,
        "Read it and answer the people here, then end your turn with reply_and_wait.",
      );
    }
    return { jobId: job.id, note: `Waiting for sandbox job ${job.id}.` };
  },
};
