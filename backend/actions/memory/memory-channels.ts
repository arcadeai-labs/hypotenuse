import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginationInputs,
} from "keryx";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { loadReadableBot } from "../../ops/BotOps";
import { serializeChannel } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { botMemoryChannels } from "../../ops/MemoryOps";

/**
 * `memory:channels` — the channels a bot works in, each with how many live
 * documents its memory of that channel holds: the memory explorer's index of
 * a bot.
 */
export class MemoryChannels implements Action {
  name = "memory:channels";
  description =
    "List the channels a bot works in, each with how many documents the bot remembers about it. Use a channel's id with memory:list, memory:search, and memory:view. Requires membership and read access to the bot. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/memory/channels",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - The bot, and the page.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The channels with their document counts, and pagination.
   */
  async run(
    params: ActionParams<MemoryChannels>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    const all = await botMemoryChannels(api.db.db, params.projectId, bot.id);
    const start = (params.page - 1) * params.limit;
    return {
      channels: all.slice(start, start + params.limit).map((row) => ({
        ...serializeChannel(row.channel),
        documents: row.documents,
      })),
      pagination: {
        page: params.page,
        limit: params.limit,
        total: all.length,
        pages: Math.ceil(all.length / params.limit),
      },
    };
  }
}
