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
 * `mcp-server:test` — connect to a server now, through the server, list its
 * tools, and record the result as its status. Requires admin standing.
 * Audited like `model-connection:test`, since it writes the status a person
 * reads.
 */
export class McpServerTest extends AuditedAction {
  name = "mcp-server:test";
  description =
    "Connect to an MCP server now with its stored credentials, list its tools, and record whether it worked (status ok, error, or needs_auth, with the reason). Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId/test",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server to test"),
  });

  /**
   * @param tx - The transaction the status and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The server, whether it worked, and why not.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerTest>,
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
    params: ActionParams<McpServerTest>,
    connection: AuditedConnection,
  ) {
    if (connection.metadata.afterCommitData?.changed)
      await enqueueCapabilitiesForServer(params.mcpServerId);
  }
}
