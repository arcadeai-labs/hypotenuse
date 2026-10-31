import { and, count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import {
  serializeBinding,
  serializePlatformChannel,
} from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";

/**
 * `channel-binding:list` — where a bot listens. Needs the bot's read access.
 */
export class ChannelBindingList implements Action {
  name = "channel-binding:list";
  description =
    "List the channels a bot is bound to, with each binding's mode, delivery, approval policy, promotion, and whether it is enabled or was bound automatically. Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/channel-bindings",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The bindings, each with its channel, and pagination metadata.
   */
  async run(
    params: ActionParams<ChannelBindingList>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    await loadReadableBot(api.db.db, params.projectId, params.botId, tags);
    const where = and(
      eq(channelBindings.projectId, params.projectId),
      eq(channelBindings.botId, params.botId),
    );
    const result = await paginate(
      api.db.db
        .select({ binding: channelBindings, channel: channels })
        .from(channelBindings)
        .innerJoin(channels, eq(channels.id, channelBindings.channelId))
        .where(where)
        .orderBy(desc(channelBindings.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(channelBindings).where(where),
      params,
    );
    return {
      bindings: result.data.map((r) => ({
        ...serializeBinding(r.binding),
        channel: serializePlatformChannel(r.channel),
      })),
      pagination: result.pagination,
    };
  }
}
