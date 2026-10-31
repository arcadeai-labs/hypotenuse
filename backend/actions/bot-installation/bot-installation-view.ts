import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  installationNotFound,
  loadInstallation,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { platformAdapter } from "../../platforms/registry";

/**
 * `bot-installation:view` — one platform app of a bot, and what its
 * platform's surface can show. Needs the bot's read access.
 */
export class BotInstallationView implements Action {
  name = "bot-installation:view";
  description =
    "Get one of a bot's platform apps: its platform, workspace, status, last error, and what the platform can show (streaming, buttons, status line…). Never the credentials. Needs the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot-installation/:installationId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    installationId: idInput("The installation"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installation and its platform's capabilities.
   */
  async run(
    params: ActionParams<BotInstallationView>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const row = await loadInstallation(
      api.db.db,
      params.projectId,
      params.installationId,
    );
    await loadReadableBot(api.db.db, params.projectId, row.botId, tags).catch(
      () => {
        throw installationNotFound();
      },
    );
    const adapter = platformAdapter(row.type);
    return {
      installation: serializeInstallation(row),
      platform: adapter
        ? {
            type: adapter.type,
            label: adapter.label,
            capabilities: adapter.capabilities,
          }
        : null,
    };
  }
}
