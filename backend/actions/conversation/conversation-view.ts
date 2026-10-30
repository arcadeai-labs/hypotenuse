import { eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import {
  loadReadableConversation,
  serializeChannel,
  serializeConversation,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { channels } from "../../schema/channels";

/**
 * `conversation:view` — one conversation, its bot, its channel, and what the
 * caller may do with it. Requires membership and the bot's read access; a
 * conversation of an unreadable bot is the same 404 as a missing one.
 */
export class ConversationView implements Action {
  name = "conversation:view";
  description =
    "Get one conversation: its state (working, hibernating, waiting — with what it waits on — or ended, with its outcome), its bot and channel, and lastSeq, the newest transcript entry. Read the transcript with conversation:entries. Requires membership and read access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
  });

  /**
   * @param params - The project and conversation.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversation, its bot, its channel, and the caller's standing.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<ConversationView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const { conversation, bot } = await loadReadableConversation(
      api.db.db,
      params.projectId,
      params.conversationId,
      callerTags,
    );
    const [channel] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.id, conversation.channelId));
    return {
      conversation: serializeConversation(conversation),
      bot: {
        id: bot.id,
        name: bot.name,
        slug: bot.slug,
        displayName: bot.displayName,
      },
      channel: serializeChannel(channel),
      // Anyone who may talk to the bot may also stop it.
      standing: {
        canMessage: true,
        canCancel: conversation.state !== "ended",
      },
    };
  }
}
