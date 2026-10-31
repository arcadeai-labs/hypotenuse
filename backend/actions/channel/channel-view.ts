import { and, eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import {
  channelNotFound,
  serializeBinding,
  serializePlatformChannel,
} from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";

/**
 * `channel:view` — one channel and the bindings of the bots the caller may
 * read. Requires membership.
 */
export class ChannelView implements Action {
  name = "channel:view";
  description =
    "Get one channel: its platform, name, whether it is private or shared, and how each bot you may read is bound there. Requires membership.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/channel/:channelId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    channelId: idInput("The channel"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The channel and its bindings.
   */
  async run(params: ActionParams<ChannelView>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const [channel] = await api.db.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, params.channelId),
          eq(channels.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!channel) throw channelNotFound();
    const readable = new Set(
      await readableIds(api.db.db, BOT_ACCESS_LIST, params.projectId, tags),
    );
    const bindings = await api.db.db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.channelId, channel.id));
    return {
      channel: serializePlatformChannel(channel),
      bindings: bindings
        .filter((b) => readable.has(b.botId))
        .map(serializeBinding),
    };
  }
}
