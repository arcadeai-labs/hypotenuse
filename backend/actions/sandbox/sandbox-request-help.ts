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
  actingBot,
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { lockConversation } from "../../ops/ConversationOps";
import { raiseJobHelpRequest } from "../../ops/HelpOps";
import { enqueueDelivery } from "../../ops/OutboxOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import {
  afterRelay,
  insertJobQuestion,
  JobEnded,
  QuestionCapReached,
  redactJobTokens,
} from "../../ops/SandboxJobOps";
import { type RelayResult, relayJobHelp } from "../../ops/SandboxRelayOps";

/**
 * `sandbox:request-help` — the coding agent escalates to the project's
 * people, outside the conversation: a help request in the Help inbox and its
 * notifications, as `escalate_to_human` raises one. The conversation hears
 * only that a person was asked, and is not woken; the answer goes back to
 * the job, collected with `sandbox:check-answer`. Counts against the job's
 * question cap. Job token only; not audited.
 */
export class SandboxRequestHelp implements Action {
  name = "sandbox:request-help";
  description =
    "Ask a person on the team for help when nobody in the conversation can answer: access you lack, a decision only staff can make. They are notified in their dashboard. Returns a questionId; collect the answer with sandbox-check-answer. Counts against your 5 questions.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/help", method: HTTP_METHOD.PUT };
  inputs = z.object({
    token: jobTokenInput,
    question: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("What you need a person on the team to tell you"),
    context: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        "What they need to know to answer: what you tried, what you found",
      ),
    urgency: z
      .enum(["low", "normal", "high"])
      .optional()
      .describe("How soon someone should look (default normal)"),
  });

  /**
   * @param params - The request.
   * @param connection - The job's connection.
   * @returns The question's id and the help request's.
   * @throws {TypedError} At the question cap.
   */
  async run(
    params: ActionParams<SandboxRequestHelp>,
    connection: JobConnection,
  ) {
    // A sandbox's own token never reaches a row or a relay.
    params = redactJobTokens(params);
    const job = actingJob(connection);
    const bot = actingBot(connection);
    let relay: RelayResult | null = null;
    let ids = { questionId: 0, helpRequestId: 0 };
    try {
      await api.db.db.transaction(async (tx) => {
        const locked = await lockConversation(tx, job.parentConversationId);
        if (!locked) throw new Error("The job's conversation is gone.");
        const question = await insertJobQuestion(tx, job.id, {
          kind: "team",
          question: params.question,
          options: null,
          blocking: true,
          urgency: params.urgency ?? "normal",
        });
        const request = await raiseJobHelpRequest(
          tx,
          locked.conversation,
          bot,
          question,
          {
            context: params.context ?? `Asked from ${job.title}`,
            urgency: params.urgency ?? "normal",
          },
        );
        ids = { questionId: question.id, helpRequestId: request.id };
        relay = await relayJobHelp(tx, locked.conversation, job, request.id);
      });
    } catch (e) {
      if (e instanceof JobEnded) {
        throw new TypedError({
          message: `${e.message} Nobody will answer; stop working.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "question",
        });
      }
      if (e instanceof QuestionCapReached) {
        throw new TypedError({
          message: `${e.message} Do not ask again: carry on with your best judgment, and say in your result what you could not resolve.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "question",
        });
      }
      throw e;
    }
    await afterRelay(job, relay);
    await enqueueDelivery([job.parentConversationId]);
    return {
      ...ids,
      note: "A person on the team was asked. Collect their answer with sandbox-check-answer; meanwhile do what you can.",
    };
  }
}
