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
  openInstallation,
  requirePlatform,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `bot-installation:test` — probe an installation's credentials against the
 * platform and record the bot's own platform id (which loop filtering reads)
 * and whether it works. Audited: it changes the installation's status.
 * Needs the bot's write access.
 */
export class BotInstallationTest extends AuditedAction {
  name = "bot-installation:test";
  description =
    "Check that a bot's platform app works: probe the platform with its credentials, and record the bot's own id there and the result (active, or error with the reason). Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot-installation/:installationId/test",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    installationId: idInput("The installation"),
  });

  /**
   * @param tx - The transaction the result and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installation and whether the probe worked.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotInstallationTest>,
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
    const adapter = requirePlatform(existing.type);
    let ok = true;
    let error: string | null = null;
    let botUserId = existing.externalBotUserId;
    if (!existing.credentials) {
      ok = false;
      error = "It has no credentials yet: connect them first.";
    } else {
      try {
        const probed = await adapter.probe(openInstallation(existing));
        botUserId = probed.externalBotUserId;
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const [row] = await tx
      .update(botInstallations)
      .set({
        externalBotUserId: botUserId,
        lastError: error,
        ...(existing.credentials
          ? { status: ok ? ("active" as const) : ("error" as const) }
          : {}),
      })
      .where(eq(botInstallations.id, existing.id))
      .returning();
    const installation = serializeInstallation(row);
    connection.metadata.auditBefore = serializeInstallation(existing);
    connection.metadata.auditAfter = installation;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/${row.type}/${row.externalWorkspaceId}`;
    return { installation, ok, error };
  }
}
