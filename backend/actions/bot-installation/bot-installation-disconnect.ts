import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  installationNotFound,
  loadInstallation,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `bot-installation:disconnect` — remove a bot's platform app from
 * Hypotenuse: its credentials are dropped and its webhook URL stops working
 * (one byte-identical 404). Its channels, bindings, and conversations stay,
 * so reconnecting picks up where it left off. Needs the bot's write access.
 */
export class BotInstallationDisconnect extends AuditedAction {
  name = "bot-installation:disconnect";
  description =
    "Disconnect a bot's platform app: forget its credentials and stop accepting its webhooks. Its channels, bindings, and conversations are kept. Remove the app on the platform too. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot-installation/:installationId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    installationId: idInput("The installation"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The removed installation.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotInstallationDisconnect>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const existing = await loadInstallation(
      tx,
      params.projectId,
      params.installationId,
    );
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      existing.botId,
      tags,
    ).catch(() => {
      throw installationNotFound();
    });
    assertCanWriteBot(bot, tags);
    await tx
      .delete(botInstallations)
      .where(eq(botInstallations.id, existing.id));
    const installation = serializeInstallation(existing);
    connection.metadata.auditBefore = installation;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/${existing.type}/${existing.externalWorkspaceId}`;
    return { installation };
  }
}
