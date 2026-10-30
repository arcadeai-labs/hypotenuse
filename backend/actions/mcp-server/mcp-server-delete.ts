import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { enqueueCapabilities } from "../../ops/McpCatalogOps";
import { retireServerClients } from "../../ops/McpClientOps";
import { loadMcpServer, serializeMcpServer } from "../../ops/McpServerOps";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:delete` — disconnect a server from a project, and from every
 * bot it was given to. Requires admin standing. Pending approvals for its
 * tools stay, and are refused if approved: the server is gone.
 */
export class McpServerDelete extends AuditedAction {
  name = "mcp-server:delete";
  description =
    "Disconnect an MCP server from a project and from every bot that used it; its stored credentials are deleted. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The deleted server.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerDelete>,
    connection: AuditedConnection,
  ) {
    const row = await loadMcpServer(tx, params.projectId, params.mcpServerId);
    const bound = await tx
      .select({ botId: botMcpServers.botId })
      .from(botMcpServers)
      .where(eq(botMcpServers.mcpServerId, row.id));
    await tx.delete(mcpServers).where(eq(mcpServers.id, row.id));
    const serialized = serializeMcpServer(row);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = row.name;
    connection.metadata.auditMetadata = {
      mcpServerId: row.id,
      unboundBotIds: bound.map((b) => b.botId),
    };
    connection.metadata.afterCommitData = {
      botIds: bound.map((b) => b.botId),
    };
    return { mcpServer: serialized };
  }

  /**
   * Close its clients; regenerate its bots' capabilities.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Which bots used it.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<McpServerDelete>,
    connection: AuditedConnection,
  ) {
    await retireServerClients(params.mcpServerId);
    for (const botId of (connection.metadata.afterCommitData?.botIds ??
      []) as number[]) {
      await enqueueCapabilities(botId);
    }
  }
}
