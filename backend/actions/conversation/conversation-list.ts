import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
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
import { conversationUrl } from "../../ops/ConversationLinkOps";
import { serializeConversation } from "../../ops/ConversationOps";
import { WAITING_KINDS } from "../../ops/DashboardOps";
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
    "List a project's conversations, most recently active first, with each one's bot, channel, state (working, hibernating, waiting, ended), and outcome. Only conversations with bots you may read are listed. Filter by botId, state, waitingKind (answer, approval, help, sandbox, timer), channelType (the platform), channelId, participantId (a platform participant who wrote in it), activeSince / activeBefore (epoch ms), or mine (conversations you started). Each carries platformUrl, a link to the thread, session, or issue on its platform when it has one. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/conversations", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("Only this bot's conversations").optional(),
    state: z
      .enum(CONVERSATION_STATES)
      .optional()
      .describe("Only conversations in this state"),
    channelType: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        "Only conversations in channels of this type, e.g. web (the dashboard chat), api, webhook",
      ),
    mine: z.stringbool().optional().describe("Only conversations you started"),
    channelId: idInput("Only conversations in this channel").optional(),
    waitingKind: z
      .enum(WAITING_KINDS)
      .optional()
      .describe(
        "Only waiting conversations waiting on this: answer, approval, help, sandbox, or timer",
      ),
    participantId: idInput(
      "Only conversations this platform participant wrote in",
    ).optional(),
    activeSince: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only conversations active at or after this time (epoch ms)"),
    activeBefore: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only conversations last active before this time (epoch ms)"),
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
      params.channelType
        ? sql`exists (select 1 from channels c where c.id = ${conversations.channelId} and c.type = ${params.channelType})`
        : undefined,
      params.channelId
        ? eq(conversations.channelId, params.channelId)
        : undefined,
      params.waitingKind
        ? and(
            eq(conversations.state, "waiting"),
            sql`${conversations.waitingOn}->>'kind' = ${params.waitingKind}`,
          )
        : undefined,
      params.participantId
        ? sql`exists (select 1 from conversation_entries e where e.conversation_id = ${conversations.id} and e.participant_id = ${params.participantId})`
        : undefined,
      params.activeSince !== undefined
        ? gte(conversations.lastActivityAt, new Date(params.activeSince))
        : undefined,
      params.activeBefore !== undefined
        ? lt(conversations.lastActivityAt, new Date(params.activeBefore))
        : undefined,
      params.mine
        ? eq(
            conversations.createdByUserId,
            connection.session?.data.userId ?? -1,
          )
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({
          conversation: conversations,
          botName: bots.name,
          botSlug: bots.slug,
          channel: channels,
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
      conversations: await Promise.all(
        result.data.map(async (row) => ({
          ...serializeConversation(row.conversation),
          bot: {
            id: row.conversation.botId,
            name: row.botName,
            slug: row.botSlug,
          },
          channel: {
            id: row.conversation.channelId,
            name: row.channel.name,
            type: row.channel.type,
          },
          platformUrl: await conversationUrl(
            api.db.db,
            row.conversation,
            row.channel,
          ),
        })),
      ),
      pagination: result.pagination,
    };
  }
}
