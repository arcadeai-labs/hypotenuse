import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import { serializeConversation } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";
import { channels } from "../../schema/channels";
import { CONVERSATION_STATES, conversations } from "../../schema/conversations";

/**
 * `conversation:list` — a project's conversations with the bots the caller
 * may read, most recently active first. A conversation of an unreadable bot
 * is absent, and the total counts only readable ones.
 */
export class ConversationList implements Action {
  name = "conversation:list";
  description =
    "List a project's conversations, most recently active first, with each one's bot, channel, state (working, hibernating, waiting, ended), and outcome. Only conversations with bots you may read are listed. Filter by botId or state. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/conversations", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("Only this bot's conversations").optional(),
    state: z
      .enum(CONVERSATION_STATES)
      .optional()
      .describe("Only conversations in this state"),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The conversations, each with its bot's name and channel, and pagination.
   */
  async run(
    params: ActionParams<ConversationList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const botIds = await readableIds(
      api.db.db,
      BOT_ACCESS_LIST,
      params.projectId,
      callerTags,
    );
    const where = and(
      eq(conversations.projectId, params.projectId),
      inArray(conversations.botId, botIds),
      params.botId ? eq(conversations.botId, params.botId) : undefined,
      params.state ? eq(conversations.state, params.state) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({
          conversation: conversations,
          botName: bots.name,
          botSlug: bots.slug,
          channelName: channels.name,
          channelType: channels.type,
        })
        .from(conversations)
        .innerJoin(bots, eq(bots.id, conversations.botId))
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .where(where)
        .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(conversations).where(where),
      params,
    );
    return {
      conversations: result.data.map((row) => ({
        ...serializeConversation(row.conversation),
        bot: {
          id: row.conversation.botId,
          name: row.botName,
          slug: row.botSlug,
        },
        channel: {
          id: row.conversation.channelId,
          name: row.channelName,
          type: row.channelType,
        },
      })),
      pagination: result.pagination,
    };
  }
}
