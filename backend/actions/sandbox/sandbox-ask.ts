import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { lockConversation } from "../../ops/ConversationOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import {
  afterRelay,
  insertJobQuestion,
  QuestionCapReached,
} from "../../ops/SandboxJobOps";
import { type RelayResult, relayJobQuestion } from "../../ops/SandboxRelayOps";

/**
 * `sandbox:ask` — the coding agent asks the conversation a question. Ask
 * now, collect later: it returns a question id at once, and
 * `sandbox:check-answer` collects the answer, which the bot gives (from what
 * it knows, or from the people it asks). A blocking question wakes the bot.
 * At most `SANDBOX_QUESTION_CAP` per job, counted under the job's row lock.
 * Job token only; not audited.
 */
export class SandboxAsk implements Action {
  name = "sandbox:ask";
  description =
    "Ask the person who gave you this task a question, when a decision is theirs and you should not guess. Returns a questionId at once; collect the answer with sandbox-check-answer. blocking (the default) means you will wait for the answer; false means carry on meanwhile. You may ask at most 5 questions in a job.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/question", method: HTTP_METHOD.PUT };
  inputs = z.object({
    token: jobTokenInput,
    question: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("The question, with the context needed to answer it"),
    options: z
      .array(z.string().trim().min(1).max(200))
      .max(10)
      .optional()
      .describe("Answers to choose from, when there are a few"),
    blocking: z
      .boolean()
      .optional()
      .describe("Whether you will wait for the answer (default true)"),
  });

  /**
   * @param params - The question.
   * @param connection - The job's connection.
   * @returns The question's id.
   * @throws {TypedError} At the question cap.
   */
  async run(params: ActionParams<SandboxAsk>, connection: JobConnection) {
    const job = actingJob(connection);
    const blocking = params.blocking !== false;
    let relay: RelayResult | null = null;
    let questionId = 0;
    try {
      await api.db.db.transaction(async (tx) => {
        const locked = await lockConversation(tx, job.parentConversationId);
        const question = await insertJobQuestion(tx, job.id, {
          kind: "conversation",
          question: params.question,
          options: params.options ?? null,
          blocking,
          urgency: null,
        });
        questionId = question.id;
        if (locked) {
          relay = await relayJobQuestion(
            tx,
            locked.conversation,
            job,
            question,
          );
        }
      });
    } catch (e) {
      if (e instanceof QuestionCapReached) {
        throw new TypedError({
          message: `${e.message} Do not ask again: carry on with your best judgment, and say in your result what you assumed.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "question",
        });
      }
      throw e;
    }
    await afterRelay(job, relay);
    return {
      questionId,
      note: blocking
        ? "Asked. Wait for the answer with sandbox-check-answer."
        : "Asked. Carry on; check for the answer later with sandbox-check-answer.",
    };
  }
}
