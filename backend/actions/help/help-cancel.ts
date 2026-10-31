import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot } from "../../ops/BotOps";
import { enqueueTick, pingConversation } from "../../ops/ConversationOps";
import {
  loadReadableHelpRequest,
  serializeHelpRequest,
  settleHelpRequest,
} from "../../ops/HelpOps";
import { idInput } from "../../ops/InputOps";
import type { Conversation } from "../../schema/conversations";

/**
 * `help:cancel` — withdraw a bot's request for help, so nobody answers it.
 * The conversation reads that it was withdrawn and carries on. Needs the
 * bot's write access.
 */
export class HelpCancel extends AuditedAction {
  name = "help:cancel";
  description =
    "Withdraw a bot's request for help: nobody needs to answer it, and the bot is told to carry on without it. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/help/:helpRequestId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    helpRequestId: idInput("The request"),
  });

  /**
   * @param tx - The transaction the change, the message, and the audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The withdrawn request.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<HelpCancel>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const { request, bot } = await loadReadableHelpRequest(
      tx,
      params.projectId,
      params.helpRequestId,
      tags,
    );
    assertCanWriteBot(bot, tags);
    const result = await settleHelpRequest(
      tx,
      request,
      { status: "cancelled", userId: connection.session?.data.userId ?? null },
      `Your request for help ("${request.question.slice(0, 200)}") was withdrawn by the team. Carry on without it.`,
    );
    connection.metadata.auditBefore = serializeHelpRequest(result.before);
    connection.metadata.auditAfter = serializeHelpRequest(result.request);
    connection.metadata.auditTargetType = "help-request";
    connection.metadata.auditTargetPath = `${bot.slug}/${request.id}`;
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
    params: ActionParams<HelpCancel>,
    connection: AuditedConnection,
  ) {
    const data = connection.metadata.afterCommitData ?? {};
    const woke = data.woke as Conversation | null | undefined;
    if (woke) await enqueueTick(woke);
    await pingConversation(params.projectId, Number(data.conversationId));
  }
}
