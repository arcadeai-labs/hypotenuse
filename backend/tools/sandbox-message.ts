import { z } from "zod";
import {
  answerJobQuestion,
  isTerminalJobStatus,
  loadJobQuestion,
  queueJobMessage,
} from "../ops/SandboxJobOps";
import { conversationJob, hasJobs } from "./sandbox-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  jobId: z.number().int().positive().describe("The job"),
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe("The answer, follow-up, or instruction"),
  questionId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Answer this question the coding agent asked"),
  steer: z
    .boolean()
    .optional()
    .describe(
      "Interrupt what the agent is doing now and give it this instead (otherwise it is its next instruction)",
    ),
});

const output = z.object({ delivered: z.string(), note: z.string() });

/**
 * `sandbox_message` — talk to a job of this conversation: answer a question
 * its agent asked (on its behalf, or passing on the people's answer), give an
 * interactive job its next instruction, or steer a running one. Replay safe:
 * the call's idempotency key makes a replayed message the same one.
 */
export const sandboxMessage: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_message",
  description:
    "Send a sandbox job this conversation started a message: with questionId, the answer to a question its coding agent asked; otherwise its next instruction (an interactive job waiting for one) or, with steer, a change of direction it gets right away.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: false,
  available: (ctx) => hasJobs(ctx),
  run: async (args, ctx) => {
    const job = await conversationJob(ctx, args.jobId);
    if (isTerminalJobStatus(job.status)) {
      throw new ToolError(
        "job_ended",
        `Sandbox job ${job.id} has already ended (${job.status.replace("_", " ")}).`,
        "Start a new job with sandbox_start if there is more to do, briefing it from what this one found.",
      );
    }
    if (args.questionId !== undefined) {
      const question = await loadJobQuestion(ctx.db, job.id, args.questionId);
      if (!question) {
        throw new ToolError(
          "not_found",
          `Job ${job.id} asked no question ${args.questionId}.`,
          "Check the question id in the job's message, or call sandbox_status.",
        );
      }
      if (question.kind === "team") {
        throw new ToolError(
          "not_yours",
          "That question went to the team's Help inbox; a person answers it there.",
          "Leave it to them.",
        );
      }
      const answered = await answerJobQuestion(ctx.db, question.id, args.text, {
        kind: "bot",
        name: ctx.bot.displayName,
      });
      return answered
        ? {
            delivered: "answer",
            note: "Answered. The agent reads it when it next checks.",
          }
        : {
            delivered: "nothing",
            note: `That question is already ${question.status}${question.answer ? `: "${question.answer.slice(0, 200)}"` : ""}.`,
          };
    }
    const steer =
      args.steer === true || (!job.interactive && job.status === "running");
    if (!steer && !job.interactive) {
      throw new ToolError(
        "not_interactive",
        `Sandbox job ${job.id} is not interactive and has not started yet, so it takes no instructions.`,
        "Wait for it to start, then steer it; or cancel it and start a new one with the full task.",
      );
    }
    await queueJobMessage(ctx.db, job, {
      body: args.text,
      source: "bot",
      delivery: steer ? "steer" : "queue",
      deliveryKey: ctx.idempotencyKey,
    });
    return {
      delivered: steer ? "steer" : "follow-up",
      note: steer
        ? "Sent. The agent gets it at its next heartbeat and changes course."
        : "Queued as the agent's next instruction.",
    };
  },
};
