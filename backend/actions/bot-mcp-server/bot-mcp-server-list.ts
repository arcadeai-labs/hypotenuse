import { asc, count, eq } from "drizzle-orm";
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
import { serializeBotMcpServer } from "../../ops/BotMcpServerOps";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `bot-mcp-server:list` — the MCP servers a bot may use, with its allowlist
 * for each, and its generated capabilities. Requires the bot's read access.
 */
export class BotMcpServerList implements Action {
  name = "bot-mcp-server:list";
  description =
    "List the MCP servers a bot may use, with its allowlist patterns and read-only setting for each, plus the generated summary of what its tools can do. Requires the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/mcp-servers",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The bindings, the capabilities, and pagination metadata.
   */
  async run(
    params: ActionParams<BotMcpServerList>,
    connection: AuditedConnection,
  ) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    const where = eq(botMcpServers.botId, bot.id);
    const result = await paginate(
      api.db.db
        .select({ binding: botMcpServers, server: mcpServers })
        .from(botMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.id, botMcpServers.mcpServerId))
        .where(where)
        .orderBy(asc(mcpServers.name))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(botMcpServers).where(where),
      params,
    );
    return {
      botMcpServers: result.data.map((r) =>
        serializeBotMcpServer(r.binding, r.server),
      ),
      capabilities: bot.capabilities,
      pagination: result.pagination,
    };
  }
}
