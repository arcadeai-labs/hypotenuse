import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import {
  bindingFor,
  bindingSettingsInputs,
  channelNotFound,
  serializeBinding,
} from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";

/**
 * `channel-binding:create` — let a bot listen in a platform channel. The
 * binding is the audience decision: everyone who can read the bot in
 * Hypotenuse can read what the channel says to it. Binding a **private**
 * channel needs `confirmAudience: true`, said in so many words; binding an
 * externally **shared** channel needs `allowShared: true`. Needs the bot's
 * write access.
 */
export class ChannelBindingCreate extends AuditedAction {
  name = "channel-binding:create";
  description =
    "Bind a bot to a platform channel, so it listens there: mode (mentions, all, dm), how messages enter a running turn, who may decide approvals in the channel, and whether facts may be promoted to project memory. Everyone who can read the bot in Hypotenuse will be able to read this channel's conversations with it and its memory; for a private channel, pass confirmAudience: true to say you mean that. A channel shared with another organization needs allowShared: true. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/channel-binding",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    channelId: idInput("The channel"),
    mode: bindingSettingsInputs.mode.optional(),
    defaultDelivery: bindingSettingsInputs.defaultDelivery.optional(),
    approvalPolicy: bindingSettingsInputs.approvalPolicy.optional(),
    approverExternalIds: bindingSettingsInputs.approverExternalIds.optional(),
    allowPromotion: bindingSettingsInputs.allowPromotion.optional(),
    allowShared: bindingSettingsInputs.allowShared.optional(),
    confirmAudience: z
      .boolean()
      .optional()
      .describe(
        "For a private channel: true to confirm that everyone who can read this bot in Hypotenuse may read this channel's conversations and memory",
      ),
  });

  /**
   * @param tx - The transaction the binding and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The binding.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ChannelBindingCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const [channel] = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, params.channelId),
          eq(channels.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!channel || channel.type === "api" || channel.type === "web") {
      throw channelNotFound();
    }
    if (await bindingFor(tx, bot.id, channel.id)) {
      throw new TypedError({
        message: `"${bot.name}" is already bound to "${channel.name}". Change the binding with channel-binding:edit.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "channelId",
      });
    }
    if (channel.isPrivate && params.confirmAudience !== true) {
      throw new TypedError({
        message: `"${channel.name}" is private. Binding it means everyone who can read "${bot.name}" in Hypotenuse will be able to read this channel's conversations and memory. Pass confirmAudience: true if that is what you mean.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "confirmAudience",
      });
    }
    if (channel.isShared && params.allowShared !== true) {
      throw new TypedError({
        message: `"${channel.name}" is shared with another organization, whose people could then talk to "${bot.name}". Pass allowShared: true if that is what you mean.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "allowShared",
      });
    }
    const [row] = await tx
      .insert(channelBindings)
      .values({
        projectId: params.projectId,
        botId: bot.id,
        channelId: channel.id,
        mode: params.mode ?? "mentions",
        defaultDelivery: params.defaultDelivery ?? "steer",
        approvalPolicy: params.approvalPolicy ?? "dashboard",
        approverExternalIds: params.approverExternalIds ?? [],
        allowPromotion: params.allowPromotion ?? false,
        allowShared: params.allowShared ?? false,
        enabled: true,
        autoBound: false,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();
    const binding = serializeBinding(row);
    connection.metadata.auditAfter = binding;
    connection.metadata.auditTargetType = "channel-binding";
    connection.metadata.auditTargetPath = `${bot.slug} in ${channel.name}`;
    connection.metadata.auditMetadata = {
      botId: bot.id,
      channelId: channel.id,
      private: channel.isPrivate,
      shared: channel.isShared,
      confirmAudience: params.confirmAudience ?? false,
    };
    return { binding };
  }
}
