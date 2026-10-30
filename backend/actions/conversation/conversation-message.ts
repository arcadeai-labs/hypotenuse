import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { scrubParams } from "../../ops/AuditOps";
import {
  conversationNotFound,
  deliveryInput,
  enqueueTick,
  loadReadableConversation,
  lockConversation,
  messageTextInput,
  pingConversation,
  receiveMessage,
  requestIdInput,
  serializeConversation,
  summarizeText,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import type { Conversation } from "../../schema/conversations";

/**
 * `conversation:message` — send a message into a conversation. It lands in
 * the inbox and the state table decides the rest: a resting or ended
 * conversation wakes for a new turn, one waiting on an answer takes this as
 * the answer, a working one sees it at its next step (`steer`) or after its
 * turn (`queue`), and one waiting on a timer gets it when the wait ends.
 * Requires membership and the bot's read access.
 */
export class ConversationMessage extends AuditedAction {
  name = "conversation:message";
  description =
    "Send a message into a conversation. If the bot is resting it wakes; if it is mid-turn the message reaches it before its next step (delivery steer, the default) or after the turn (queue); if it asked a question this is the answer. Pass requestId to make retries safe. Requires membership and read access to the conversation's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/message",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
    text: messageTextInput,
    delivery: deliveryInput.optional(),
    requestId: requestIdInput.optional(),
  });

  /**
   * @param tx - The transaction the inbox row, the wake, and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversation as it now stands, and whether this was a repeat.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConversationMessage>,
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
    const received = await receiveMessage(tx, locked.conversation, {
      text: params.text,
      delivery: params.delivery ?? "steer",
      deliveryKey: params.requestId,
      source: "user",
      userId: connection.session?.data.userId ?? null,
    });
    const serialized = serializeConversation(received.conversation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "conversation";
    connection.metadata.auditTargetPath = String(received.conversation.id);
    connection.metadata.auditMetadata = {
      ...scrubParams({ ...params, text: undefined }),
      text: summarizeText(params.text),
    };
    connection.metadata.afterCommitData = {
      tick: received.woke ? received.conversation : null,
      projectId: params.projectId,
    };
    return {
      conversation: serialized,
      deduped: received.duplicate,
      message: {
        deliveryKey: received.inbox.deliveryKey,
        delivery: received.inbox.delivery,
        delivered: received.inbox.deliveredAt !== null,
        createdAt: received.inbox.createdAt.getTime(),
      },
    };
  }

  /**
   * Enqueue the tick a wake owes, and ping the transcript page.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Carries the woken conversation, if one woke.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<ConversationMessage>,
    connection: AuditedConnection,
  ) {
    const woken = connection.metadata.afterCommitData?.tick as
      | Conversation
      | null
      | undefined;
    if (woken) await enqueueTick(woken);
    await pingConversation(params.projectId, params.conversationId);
  }
}
