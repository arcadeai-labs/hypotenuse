import {
  type Action,
  type ActionParams,
  api,
  config,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { idInput } from "../../ops/InputOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import { loadJobQuestion, touchJobActivity } from "../../ops/SandboxJobOps";

/** How often a waiting check re-reads its question. */
const POLL_MS = 500;

/**
 * `sandbox:check-answer` — collect the answer to a question this job asked
 * (`sandbox:ask` or `sandbox:request-help`), waiting up to `waitMs`. **A wait
 * that runs out is not an error**: it answers `pending` with `timedOut`, and
 * a sentence the agent can act on. Every check counts as activity, so a job
 * waiting on a person is never reaped as stalled. Job token only; not audited.
 */
export class SandboxCheckAnswer implements Action {
  name = "sandbox:check-answer";
  description =
    "Collect the answer to a question you asked with sandbox-ask or sandbox-request-help, waiting up to waitMs (at most 25 seconds) for it. If it is still pending, call again; if you cannot wait any longer, carry on with your best judgment and say what you assumed.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/question/:questionId", method: HTTP_METHOD.GET };
  timeout = 60_000;
  inputs = z.object({
    token: jobTokenInput,
    questionId: idInput("The question's id, from sandbox-ask"),
    waitMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe(
        "How long to wait for an answer, in milliseconds (default 20000)",
      ),
  });

  /**
   * @param params - The question and how long to wait.
   * @param connection - The job's connection.
   * @returns The answer, or `pending` and whether the wait ran out.
   */
  async run(
    params: ActionParams<SandboxCheckAnswer>,
    connection: JobConnection,
  ) {
    const job = actingJob(connection);
    // One waiting check per job at a time: a second answers at once rather
    // than holding another request open polling the database.
    const lock = `sandbox:check-answer:${job.id}`;
    const held = await api.redis.redis.set(
      lock,
      "1",
      "PX",
      config.sandbox.maxCheckWaitMs + 5_000,
      "NX",
    );
    try {
      return await this.check(params, job.id, held === "OK");
    } finally {
      if (held === "OK") await api.redis.redis.del(lock);
    }
  }

  /**
   * Read the question, waiting for an answer only when this call holds the
   * job's check.
   * @param params - The question and how long to wait.
   * @param jobId - The job.
   * @param mayWait - Whether this call may wait.
   * @returns The answer, or `pending` and whether the wait ran out.
   */
  private async check(
    params: ActionParams<SandboxCheckAnswer>,
    jobId: number,
    mayWait: boolean,
  ) {
    const job = { id: jobId };
    const waitMs = mayWait
      ? Math.min(params.waitMs ?? 20_000, config.sandbox.maxCheckWaitMs)
      : 0;
    const deadline = Date.now() + waitMs;
    await touchJobActivity(api.db.db, job.id);
    for (;;) {
      const question = await loadJobQuestion(
        api.db.db,
        job.id,
        params.questionId,
      );
      if (!question) {
        return {
          status: "unknown",
          timedOut: false,
          note: `This job asked no question ${params.questionId}. Check the id sandbox-ask returned.`,
        };
      }
      if (question.status === "answered") {
        await touchJobActivity(api.db.db, job.id);
        return {
          status: "answered",
          answer: question.answer,
          answeredBy:
            question.answeredBy?.name ?? question.answeredBy?.kind ?? null,
          timedOut: false,
        };
      }
      if (question.status !== "pending") {
        return {
          status: question.status,
          timedOut: false,
          note: "Nobody will answer this question. Carry on with your best judgment, and say what you assumed.",
        };
      }
      if (Date.now() >= deadline) {
        await touchJobActivity(api.db.db, job.id);
        return {
          status: "pending",
          timedOut: true,
          note: "No answer yet. Check again, or carry on with what you can do meanwhile.",
        };
      }
      await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
