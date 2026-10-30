import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  enqueueCapabilitiesForServer,
  refreshCatalog,
} from "../../ops/McpCatalogOps";
import { loadMcpServer, serializeMcpServer } from "../../ops/McpServerOps";

/**
 * `mcp-server:refresh-tools` — re-list a server's tools now instead of
 * waiting for the hourly refresh. Requires admin standing. The same work as
 * `mcp-server:test`, named for what a person browsing the catalog wants.
 */
export class McpServerRefreshTools extends AuditedAction {
  name = "mcp-server:refresh-tools";
  description =
    "Re-list an MCP server's tools now and store the catalog (it is otherwise refreshed hourly); bots bound to it get their capabilities regenerated if it changed. Records whether the connection worked. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId/refresh",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server to refresh"),
  });

  /**
   * @param tx - The transaction the status and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The server, whether it worked, and why not.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerRefreshTools>,
    connection: AuditedConnection,
  ) {
    const before = await loadMcpServer(
      tx,
      params.projectId,
      params.mcpServerId,
    );
    connection.metadata.auditBefore = serializeMcpServer(before);
    const result = await refreshCatalog(before, tx);
    const serialized = serializeMcpServer(result.server);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = before.name;
    connection.metadata.afterCommitData = { changed: result.changed };
    return {
      mcpServer: serialized,
      ok: result.ok,
      toolCount: result.toolCount,
      error: result.error,
    };
  }

  /**
   * Regenerate bound bots' capabilities when the catalog changed.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Whether it changed.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<McpServerRefreshTools>,
    connection: AuditedConnection,
  ) {
    if (connection.metadata.afterCommitData?.changed)
      await enqueueCapabilitiesForServer(params.mcpServerId);
  }
}
