import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadWritableBinding } from "../../ops/ChannelBindingOps";
import { serializeBinding } from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { channelBindings } from "../../schema/channel_bindings";

/**
 * `channel-binding:delete` — stop a bot listening in a channel. Its
 * conversations and channel memory stay. A bot whose `autoBind` covers the
 * channel binds itself again the next time it is addressed there; disable
 * the binding instead to keep it quiet. Needs the bot's write access.
 */
export class ChannelBindingDelete extends AuditedAction {
  name = "channel-binding:delete";
  description =
    "Remove a bot's binding to a channel. Its conversations and memory stay. If the bot binds itself in channels of this kind (autoBind), it will bind again when next addressed; to keep it quiet, edit the binding to enabled: false instead. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/channel-binding/:bindingId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    bindingId: idInput("The binding"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The removed binding.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ChannelBindingDelete>,
    connection: AuditedConnection,
  ) {
    const { binding, bot, channel } = await loadWritableBinding(
      tx,
      params.projectId,
      params.bindingId,
      connection.metadata.callerTags ?? [],
    );
    await tx.delete(channelBindings).where(eq(channelBindings.id, binding.id));
    connection.metadata.auditBefore = serializeBinding(binding);
    connection.metadata.auditTargetType = "channel-binding";
    connection.metadata.auditTargetPath = `${bot.slug} in ${channel.name}`;
    return { binding: serializeBinding(binding) };
  }
}
