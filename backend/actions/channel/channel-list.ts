import {
  and,
  count,
  desc,
  eq,
  inArray,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import {
  serializeBinding,
  serializePlatformChannel,
} from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";

/**
 * `channel:list` — a project's platform channels. With `botId`, the channels
 * that bot is bound to and the ones its platform apps have heard from, each
 * with the bot's binding (or `null`, for a channel a person may bind).
 * Requires membership (and the bot's read access with `botId`).
 */
export class ChannelList implements Action {
  name = "channel:list";
  description =
    "List a project's platform channels (Slack channels, Linear projects, webhook channels…), newest first. With botId: the channels that bot is bound to or has heard from, each with its binding (null when unbound, which a person with write access may bind). The API and dashboard channels are not listed. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/channels", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput(
      "Only channels this bot is bound to or has heard from",
    ).optional(),
    type: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe("Only this platform, e.g. webhook"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The channels and pagination metadata.
   */
  async run(params: ActionParams<ChannelList>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    let botFilter = undefined as ReturnType<typeof or> | undefined;
    if (params.botId) {
      await loadReadableBot(api.db.db, params.projectId, params.botId, tags);
      const installationIds = (
        await api.db.db
          .select({ id: botInstallations.id })
          .from(botInstallations)
          .where(eq(botInstallations.botId, params.botId))
      ).map((r) => r.id);
      botFilter = or(
        sql`exists (select 1 from channel_bindings b where b.channel_id = ${channels.id} and b.bot_id = ${params.botId})`,
        inArray(
          channels.botInstallationId,
          installationIds.length ? installationIds : [-1],
        ),
      );
    }
    const where = and(
      eq(channels.projectId, params.projectId),
      notInArray(channels.type, ["api", "web"]),
      params.type ? eq(channels.type, params.type) : undefined,
      botFilter,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(channels)
        .where(where)
        .orderBy(desc(channels.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(channels).where(where),
      params,
    );
    const bindings = params.botId
      ? await api.db.db
          .select()
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.botId, params.botId),
              inArray(
                channelBindings.channelId,
                result.data.length ? result.data.map((c) => c.id) : [-1],
              ),
            ),
          )
      : [];
    return {
      channels: result.data.map((c) => {
        const b = bindings.find((x) => x.channelId === c.id);
        return {
          ...serializePlatformChannel(c),
          ...(params.botId ? { binding: b ? serializeBinding(b) : null } : {}),
        };
      }),
      pagination: result.pagination,
    };
  }
}
