import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { sandboxJobQuestions } from "../schema/sandbox_job_questions";
import { sandboxJobs } from "../schema/sandbox_jobs";
import { conversationJob, hasJobs } from "./sandbox-shared";
import type { ToolDefinition } from "./types";

const input = z.object({
  jobId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The job; omit to list this conversation's jobs"),
});

const output = z.record(z.string(), z.unknown());

/** The longest closing text a status shows. */
const CLOSING_LIMIT = 4_000;

/**
 * `sandbox_status` — how a job of this conversation is doing: its status,
 * what the agent last reported, its open questions, and — once it ended —
 * its closing text and artifacts. Without a job id, the conversation's jobs.
 * Replay safe: it reads.
 */
export const sandboxStatus: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_status",
  description:
    "Check on a sandbox job this conversation started: its status, what the coding agent last reported, questions waiting for an answer, and once it ends, its closing message and artifacts. Without jobId, lists this conversation's jobs.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => hasJobs(ctx),
  run: async (args, ctx) => {
    if (args.jobId === undefined) {
      const jobs = await ctx.db
        .select()
        .from(sandboxJobs)
        .where(eq(sandboxJobs.parentConversationId, ctx.conversation.id))
        .orderBy(desc(sandboxJobs.id))
        .limit(10);
      return {
        jobs: jobs.map((j) => ({
          jobId: j.id,
          title: j.title,
          status: j.status,
          reportedStatus: j.statusMessage,
        })),
      };
    }
    const job = await conversationJob(ctx, args.jobId);
    const questions = await ctx.db
      .select()
      .from(sandboxJobQuestions)
      .where(eq(sandboxJobQuestions.jobId, job.id))
      .orderBy(asc(sandboxJobQuestions.id));
    return {
      jobId: job.id,
      title: job.title,
      status: job.status,
      interactive: job.interactive,
      reportedStatus: job.reportedStatus,
      statusMessage: job.statusMessage,
      questions: questions.map((q) => ({
        questionId: q.id,
        to: q.kind,
        question: q.question,
        status: q.status,
        answer: q.answer,
      })),
      closingText: job.closingText
        ? job.closingText.slice(0, CLOSING_LIMIT)
        : null,
      artifacts: Object.fromEntries(
        Object.entries(job.artifacts ?? {}).map(([name, a]) => [
          name,
          a.content.slice(0, CLOSING_LIMIT),
        ]),
      ),
      error: job.error,
      usage: job.usage,
    };
  },
};
