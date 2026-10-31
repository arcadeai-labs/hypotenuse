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
import { idInput } from "../../ops/InputOps";
import { serializeInstallation } from "../../ops/InstallationOps";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `bot-installation:list` — a bot's platform apps. Needs the bot's read access.
 */
export class BotInstallationList implements Action {
  name = "bot-installation:list";
  description =
    "List a bot's platform apps (installations): platform, workspace, status, and the bot's id there. Never the credentials. Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/installations",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installations and pagination metadata.
   */
  async run(
    params: ActionParams<BotInstallationList>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    await loadReadableBot(api.db.db, params.projectId, params.botId, tags);
    const where = and(
      eq(botInstallations.projectId, params.projectId),
      eq(botInstallations.botId, params.botId),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(botInstallations)
        .where(where)
        .orderBy(desc(botInstallations.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(botInstallations).where(where),
      params,
    );
    return {
      installations: result.data.map(serializeInstallation),
      pagination: result.pagination,
    };
  }
}
