import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { scrubParams } from "../../ops/AuditOps";
import { loadReadableBot } from "../../ops/BotOps";
import {
  enqueueTick,
  lockConversation,
  messageTextInput,
  pingConversation,
  receiveMessage,
  requestIdInput,
  serializeChannel,
  serializeConversation,
  summarizeText,
  upsertApiChannel,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { missingRequiredAliases } from "../../ops/ModelOps";
import { urlRefusal } from "../../ops/NetworkGuardOps";
import { channels } from "../../schema/channels";
import { type Conversation, conversations } from "../../schema/conversations";

/**
 * `conversation:create` — start a conversation with a bot over the API
 * channel: upsert the channel, insert the conversation and its first
 * message, and wake it. A repeated `requestId` returns the conversation the
 * first call made. Requires membership and the bot's **read** access: talking
 * to a bot asks no more than a platform channel would.
 */
export class ConversationCreate extends AuditedAction {
  name = "conversation:create";
  description =
    "Start a conversation with a bot and send it the first message. The bot answers in the background: poll conversation:entries (since a seq), or pass callbackUrl to have each reply POSTed there, signed with the bot's callback secret. Pass requestId to make retries safe. Requires membership and read access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/conversation",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot to talk to"),
    text: messageTextInput,
    channelKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/, "Letters, digits, dots, dashes, underscores")
      .optional()
      .describe(
        'Which of the bot\'s API channels to use (default "default"); a channel is the boundary of what the bot remembers',
      ),
    callbackUrl: z
      .string()
      .trim()
      .url("The callback URL must be an absolute URL")
      .max(2048)
      .optional()
      .describe(
        "A public https URL to POST each of the bot's messages to, signed with Hypotenuse-Signature",
      ),
    requestId: requestIdInput.optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "A title for the conversation; the first line of text if omitted",
      ),
  });

  /**
   * @param tx - The transaction the conversation, its message, and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversation, its channel, and whether this was a repeat.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` for a bot the caller cannot
   *   read; `CONNECTION_ACTION_PARAM_VALIDATION` for a disabled bot, missing
   *   models, or an unusable callback.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConversationCreate>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      params.botId,
      callerTags,
    );
    connection.metadata.auditTargetType = "conversation";
    connection.metadata.auditMetadata = {
      ...scrubParams({ ...params, text: undefined }),
      text: summarizeText(params.text),
    };

    if (params.requestId) {
      const [existing] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.botId, bot.id),
            eq(conversations.requestId, params.requestId),
          ),
        )
        .limit(1);
      if (existing) return this.answer(tx, existing, true, connection);
    }

    if (!bot.enabled) {
      throw new TypedError({
        message: `"${bot.name}" is disabled, so it takes no new conversations. Someone with write access can enable it on its page.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "botId",
      });
    }
    const missing = await missingRequiredAliases(tx, params.projectId);
    if (missing.length > 0) {
      throw new TypedError({
        message: `This project has not chosen its ${missing.map((m) => `"${m}"`).join(" and ")} model yet, so no bot can run. A project admin sets it under Settings → Models.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "botId",
      });
    }
    if (params.callbackUrl) {
      const refusal = await urlRefusal(params.callbackUrl);
      if (refusal) {
        throw new TypedError({
          message: refusal.replace("The base URL", "The callback URL"),
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "callbackUrl",
        });
      }
      if (!bot.apiCallbackSecret) {
        throw new TypedError({
          message: `"${bot.name}" has no callback secret yet, so its callbacks could not be signed. Create one with bot:rotate-callback-secret (keep it: it is shown once), then retry.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "callbackUrl",
        });
      }
    }

    const channel = await upsertApiChannel(
      tx,
      bot,
      params.channelKey ?? "default",
    );
    const [inserted] = await tx
      .insert(conversations)
      .values({
        projectId: params.projectId,
        botId: bot.id,
        channelId: channel.id,
        // Never derived from the text: the audit row keeps only its digest.
        title: params.title ?? null,
        state: "hibernating",
        requestId: params.requestId ?? null,
        callbackUrl: params.callbackUrl ?? null,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      // Another request with this requestId won the race.
      const [existing] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.botId, bot.id),
            eq(conversations.requestId, params.requestId ?? ""),
          ),
        )
        .limit(1);
      return this.answer(tx, existing, true, connection);
    }

    const locked = await lockConversation(tx, inserted.id);
    if (!locked) throw new Error("The conversation vanished while starting");
    const received = await receiveMessage(tx, locked.conversation, {
      text: params.text,
      delivery: "queue",
      deliveryKey: params.requestId ? `create:${params.requestId}` : undefined,
      source: "user",
      userId: connection.session?.data.userId ?? null,
    });
    return this.answer(tx, received.conversation, false, connection);
  }

  /**
   * Shape the answer and the audit snapshot.
   * @param tx - The transaction.
   * @param conversation - The conversation.
   * @param deduped - Whether a repeated `requestId` found it.
   * @param connection - The caller's connection.
   * @returns The response.
   */
  private async answer(
    tx: TxHandle,
    conversation: Conversation,
    deduped: boolean,
    connection: AuditedConnection,
  ) {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(eq(channels.id, conversation.channelId));
    const serialized = serializeConversation(conversation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetPath = String(conversation.id);
    connection.metadata.afterCommitData = {
      tick: conversation.state === "working" ? conversation : null,
    };
    return {
      conversation: serialized,
      channel: serializeChannel(channel),
      deduped,
    };
  }

  /**
   * Enqueue the tick the new conversation is owed.
   * @param _result - The response.
   * @param _params - The inputs.
   * @param connection - Carries the woken conversation.
   */
  async afterCommit(
    _result: unknown,
    _params: unknown,
    connection: AuditedConnection,
  ) {
    const woken = connection.metadata.afterCommitData?.tick as
      | Conversation
      | null
      | undefined;
    if (woken) {
      await enqueueTick(woken);
      await pingConversation(woken.projectId, woken.id);
    }
  }
}
