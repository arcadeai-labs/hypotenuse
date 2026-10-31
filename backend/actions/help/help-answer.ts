import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  enqueueTick,
  pingConversation,
  summarizeText,
} from "../../ops/ConversationOps";
import {
  canAnswerHelp,
  loadReadableHelpRequest,
  serializeHelpRequest,
  settleHelpRequest,
} from "../../ops/HelpOps";
import { idInput } from "../../ops/InputOps";
import type { Conversation } from "../../schema/conversations";
import { users } from "../../schema/users";

/**
 * `help:answer` — answer a bot's request for help. The answer reaches the
 * conversation as a system message ("Answer from <name>: …") and wakes it.
 * Needs the bot's read access, and to be someone the request would notify
 * (a holder of its `helpNotifyTag`, an admin) or able to write the bot.
 */
export class HelpAnswer extends AuditedAction {
  name = "help:answer";
  description =
    "Answer a bot's request for help. The bot reads it as a message \"Answer from <your name>: …\" and carries on. Only the people the bot asks (its help tag's holders, or admins) and those who may write the bot may answer. Requires membership and read access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/help/:helpRequestId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    helpRequestId: idInput("The request"),
    answer: z
      .string()
      .trim()
      .min(1, "An answer needs text")
      .max(10_000)
      .describe("Your answer, in markdown"),
  });

  /**
   * @param tx - The transaction the answer, the message, and the audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The answered request.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<HelpAnswer>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const { request, bot } = await loadReadableHelpRequest(
      tx,
      params.projectId,
      params.helpRequestId,
      tags,
    );
    if (!canAnswerHelp(bot, tags)) {
      throw new TypedError({
        message: `You can see this request but not answer it: that takes the "${bot.helpNotifyTag ?? "admin"}" tag or write access to "${bot.name}".`,
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    const userId = connection.session?.data.userId ?? null;
    const [me] = userId
      ? await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, userId))
      : [];
    const result = await settleHelpRequest(
      tx,
      request,
      { status: "answered", answer: params.answer, userId },
      `Answer from ${me?.name ?? "a person on the team"}: ${params.answer}`,
    );
    connection.metadata.auditBefore = serializeHelpRequest(result.before);
    connection.metadata.auditAfter = {
      ...serializeHelpRequest(result.request),
      answer: summarizeText(params.answer),
    };
    connection.metadata.auditTargetType = "help-request";
    connection.metadata.auditTargetPath = `${bot.slug}/${request.id}`;
    connection.metadata.auditMetadata = {
      helpRequestId: request.id,
      answer: summarizeText(params.answer),
    };
    connection.metadata.afterCommitData = {
      woke: result.woke,
      conversationId: request.conversationId,
    };
    return { helpRequest: serializeHelpRequest(result.request) };
  }

  /**
   * A woken conversation owes a tick; its page re-reads.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - The woken conversation, if any.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<HelpAnswer>,
    connection: AuditedConnection,
  ) {
    const data = connection.metadata.afterCommitData ?? {};
    const woke = data.woke as Conversation | null | undefined;
    if (woke) await enqueueTick(woke);
    await pingConversation(params.projectId, Number(data.conversationId));
  }
}
