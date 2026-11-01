import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot } from "../../ops/BotOps";
import { summarizeText } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import {
  answerJobQuestion,
  loadJobQuestion,
  loadReadableJob,
  serializeJobQuestion,
} from "../../ops/SandboxJobOps";
import { users } from "../../schema/users";

/**
 * `sandbox-job:answer` — a person answers a coding agent's question from the
 * dashboard. The agent collects it with `sandbox-check-answer`. A question
 * already answered (by the bot, or someone else) is refused. Needs write
 * access to the bot.
 */
export class SandboxJobAnswer extends AuditedAction {
  name = "sandbox-job:answer";
  description =
    "Answer a question a sandbox job's coding agent asked. The agent reads your answer the next time it checks. Requires membership and write access to the job's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/sandbox-job/:jobId/question/:questionId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    jobId: idInput("The job"),
    questionId: idInput("The question"),
    answer: z
      .string()
      .trim()
      .min(1, "An answer needs text")
      .max(10_000)
      .describe("Your answer"),
  });

  /**
   * @param tx - The transaction the answer and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The answered question.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SandboxJobAnswer>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const { job, bot } = await loadReadableJob(
      tx,
      params.projectId,
      params.jobId,
      tags,
    );
    assertCanWriteBot(bot, tags);
    const before = await loadJobQuestion(tx, job.id, params.questionId);
    if (!before) {
      throw new TypedError({
        message: "This job asked no such question.",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    if (before.kind === "team" && before.helpRequestId) {
      throw new TypedError({
        message: `This question went to the team: answer it in the Help inbox (request ${before.helpRequestId}).`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "questionId",
      });
    }
    const userId = connection.session?.data.userId ?? null;
    const [me] = userId
      ? await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, userId))
      : [];
    const answered = await answerJobQuestion(tx, before.id, params.answer, {
      kind: "user",
      userId,
      name: me?.name ?? null,
    });
    if (!answered) {
      throw new TypedError({
        message: `This question is already ${before.status}.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "questionId",
      });
    }
    connection.metadata.auditBefore = serializeJobQuestion(before);
    connection.metadata.auditAfter = {
      ...serializeJobQuestion(answered),
      answer: summarizeText(params.answer),
    };
    connection.metadata.auditTargetType = "sandbox-question";
    connection.metadata.auditTargetPath = `${bot.slug}/${job.id}/${before.id}`;
    return { question: serializeJobQuestion(answered) };
  }
}
