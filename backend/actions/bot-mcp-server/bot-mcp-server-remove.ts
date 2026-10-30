import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeBotMcpServer } from "../../ops/BotMcpServerOps";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { enqueueCapabilities } from "../../ops/McpCatalogOps";
import { loadMcpServer } from "../../ops/McpServerOps";
import { botMcpServers } from "../../schema/bot_mcp_servers";

/**
 * `bot-mcp-server:remove` — take an MCP server away from a bot. Requires the
 * bot's write access.
 */
export class BotMcpServerRemove extends AuditedAction {
  name = "bot-mcp-server:remove";
  description =
    "Take an MCP server away from a bot: it can no longer search or call that server's tools. Requires the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/mcp-server/:mcpServerId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    mcpServerId: idInput("The server to take away"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The removed binding.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when the bot does not have it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotMcpServerRemove>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const server = await loadMcpServer(
      tx,
      params.projectId,
      params.mcpServerId,
    );
    const [row] = await tx
      .delete(botMcpServers)
      .where(
        and(
          eq(botMcpServers.botId, bot.id),
          eq(botMcpServers.mcpServerId, server.id),
        ),
      )
      .returning();
    if (!row) {
      throw new TypedError({
        message: `${bot.name} does not use ${server.name}.`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const serialized = serializeBotMcpServer(row, server);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "bot-mcp-server";
    connection.metadata.auditTargetPath = `${bot.slug}/${server.name}`;
    return { botMcpServer: serialized };
  }

  /**
   * The bot can do less now.
   * @param _result - The response.
   * @param params - The inputs.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<BotMcpServerRemove>,
  ) {
    await enqueueCapabilities(params.botId);
  }
}
