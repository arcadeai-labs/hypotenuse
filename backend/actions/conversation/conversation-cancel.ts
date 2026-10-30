import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  conversationNotFound,
  enqueueTick,
  loadReadableConversation,
  lockConversation,
  pingConversation,
  requestCancel,
  serializeConversation,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import type { Conversation } from "../../schema/conversations";

/**
 * `conversation:cancel` — stop a conversation. A resting or waiting one ends
 * at once; a working one is flagged, and the tick holding it aborts its model
 * call, settles open calls as interrupted, and ends it. Cancelling an ended
 * conversation changes nothing. Requires membership and the bot's read access.
 */
export class ConversationCancel extends AuditedAction {
  name = "conversation:cancel";
  description =
    "Cancel a conversation: stop whatever the bot is doing and end it as cancelled. A bot mid-step stops within about a second; cancelling an ended conversation does nothing. Writing to it again starts a new turn. Requires membership and read access to the conversation's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/cancel",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation to cancel"),
  });

  /**
   * @param tx - The transaction the cancel and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversation, and whether it has ended or a cancel is pending.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConversationCancel>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    await loadReadableConversation(
      tx,
      params.projectId,
      params.conversationId,
      callerTags,
    );
    const locked = await lockConversation(tx, params.conversationId);
    // Deleted between the read and the lock: the same 404.
    if (!locked) throw conversationNotFound();
    connection.metadata.auditBefore = serializeConversation(
      locked.conversation,
    );
    const result = await requestCancel(tx, locked.conversation);
    const serialized = serializeConversation(result.conversation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "conversation";
    connection.metadata.auditTargetPath = String(result.conversation.id);
    connection.metadata.afterCommitData = {
      tick: result.kind === "requested" ? result.conversation : null,
    };
    return { conversation: serialized, result: result.kind };
  }

  /**
   * Make sure a tick comes to finalize a pending cancel, and ping the page.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Carries the flagged conversation, if flagged.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<ConversationCancel>,
    connection: AuditedConnection,
  ) {
    const flagged = connection.metadata.afterCommitData?.tick as
      | Conversation
      | null
      | undefined;
    if (flagged) await enqueueTick(flagged);
    await pingConversation(params.projectId, params.conversationId);
  }
}
