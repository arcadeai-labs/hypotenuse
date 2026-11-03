import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot } from "../../ops/BotOps";
import {
  conversationNotFound,
  enqueueTick,
  loadReadableConversation,
  lockConversation,
  pingConversation,
  serializeConversation,
  wake,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { appendEntries } from "../../ops/TranscriptOps";
import type { Conversation } from "../../schema/conversations";

/**
 * `conversation:retry` — start a failed conversation's turn again. Only a
 * conversation that ended `failed` can be retried; the wake is the same one a
 * new message runs (a new turn, epoch + 1, every pending inbox row
 * delivered), and the model is told a person asked it to try again, so it
 * reads its own failure in the transcript rather than repeating it blindly.
 * Nothing that already ran is replayed: the failed turn's open calls were
 * settled as interrupted when it failed. Requires write access to the bot,
 * because a retry spends a turn on its model.
 */
export class ConversationRetry extends AuditedAction {
  name = "conversation:retry";
  description =
    "Retry a conversation whose last turn failed: the bot starts a new turn, told that a person asked it to try again, with the failure in its transcript. Refused unless the conversation ended with outcome failed. Requires membership and write access to the conversation's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/retry",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation to retry"),
  });

  /**
   * @param tx - The transaction the wake and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversation, now working.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`, `CONNECTION_CHANNEL_AUTHORIZATION`, `CONNECTION_ACTION_PARAM_VALIDATION`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConversationRetry>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const { bot } = await loadReadableConversation(
      tx,
      params.projectId,
      params.conversationId,
      callerTags,
    );
    assertCanWriteBot(bot, callerTags);
    const locked = await lockConversation(tx, params.conversationId);
    if (!locked) throw conversationNotFound();
    const before = locked.conversation;
    if (before.state !== "ended" || before.outcome !== "failed") {
      throw new TypedError({
        message: `Only a conversation whose turn failed can be retried; this one is ${before.state}${before.outcome ? ` (${before.outcome})` : ""}. Send it a message instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    connection.metadata.auditBefore = serializeConversation(before);
    const woken = await wake(tx, before, "retry");
    await appendEntries(tx, woken.id, woken.epoch, [
      {
        kind: "status_change",
        content: {
          from: "working",
          to: "working",
          reason: "retry",
          text: "A person asked you to try again. Your last turn failed; read why above before you repeat what you did.",
          visibleToModel: true,
        },
      },
    ]);
    const serialized = serializeConversation(woken);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "conversation";
    connection.metadata.auditTargetPath = String(woken.id);
    connection.metadata.afterCommitData = { tick: woken };
    return { conversation: serialized };
  }

  /**
   * Enqueue the tick the wake owes, and ping the pages.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Carries the woken conversation.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<ConversationRetry>,
    connection: AuditedConnection,
  ) {
    const woken = connection.metadata.afterCommitData?.tick as
      | Conversation
      | undefined;
    if (woken) await enqueueTick(woken);
    await pingConversation(params.projectId, params.conversationId);
  }
}
