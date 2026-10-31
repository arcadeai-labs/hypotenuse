import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadWritableBinding } from "../../ops/ChannelBindingOps";
import { bindingSettingsInputs, serializeBinding } from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { channelBindings } from "../../schema/channel_bindings";

/**
 * `channel-binding:edit` — change how a bot listens in a channel: its mode,
 * delivery, approval policy (an audited decision about who may approve tool
 * calls from inside the channel), promotion, or whether it listens at all.
 * Needs the bot's write access.
 */
export class ChannelBindingEdit extends AuditedAction {
  name = "channel-binding:edit";
  description =
    "Change a bot's binding in a channel: mode (mentions, all, dm), delivery (steer, queue), approval policy (dashboard, participants, listed with approverExternalIds), promotion, shared-channel opt-in, or enabled. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/channel-binding/:bindingId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    bindingId: idInput("The binding"),
    mode: bindingSettingsInputs.mode.optional(),
    defaultDelivery: bindingSettingsInputs.defaultDelivery.optional(),
    approvalPolicy: bindingSettingsInputs.approvalPolicy.optional(),
    approverExternalIds: bindingSettingsInputs.approverExternalIds.optional(),
    allowPromotion: bindingSettingsInputs.allowPromotion.optional(),
    allowShared: bindingSettingsInputs.allowShared.optional(),
    enabled: bindingSettingsInputs.enabled.optional(),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The binding.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ChannelBindingEdit>,
    connection: AuditedConnection,
  ) {
    const { binding, bot, channel } = await loadWritableBinding(
      tx,
      params.projectId,
      params.bindingId,
      connection.metadata.callerTags ?? [],
    );
    const policy = params.approvalPolicy ?? binding.approvalPolicy;
    const listed = params.approverExternalIds ?? binding.approverExternalIds;
    if (policy === "listed" && listed.length === 0) {
      throw new TypedError({
        message:
          "The listed policy needs at least one approver: pass approverExternalIds with the platform user ids who may decide.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "approverExternalIds",
      });
    }
    const set = Object.fromEntries(
      Object.entries({
        mode: params.mode,
        defaultDelivery: params.defaultDelivery,
        approvalPolicy: params.approvalPolicy,
        approverExternalIds: params.approverExternalIds,
        allowPromotion: params.allowPromotion,
        allowShared: params.allowShared,
        enabled: params.enabled,
      }).filter(([, v]) => v !== undefined),
    );
    const [row] =
      Object.keys(set).length > 0
        ? await tx
            .update(channelBindings)
            .set(set)
            .where(eq(channelBindings.id, binding.id))
            .returning()
        : [binding];
    connection.metadata.auditBefore = serializeBinding(binding);
    connection.metadata.auditAfter = serializeBinding(row);
    connection.metadata.auditTargetType = "channel-binding";
    connection.metadata.auditTargetPath = `${bot.slug} in ${channel.name}`;
    return { binding: serializeBinding(row) };
  }
}
