import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { startSignIn } from "../../ops/McpOAuthOps";
import { loadMcpServer, serializeMcpServer } from "../../ops/McpServerOps";

/**
 * `mcp-server:oauth-start` — the first hop of signing a project in to an
 * OAuth MCP server: discover its authorization server, register a client if
 * none was given, and send the admin's browser there with PKCE. Requires
 * admin standing. A browser hop, never an MCP tool.
 */
export class McpServerOauthStart extends AuditedAction {
  name = "mcp-server:oauth-start";
  description =
    "Begin signing a project in to an OAuth MCP server: redirects the browser to the server's authorization page (or, with format json, answers its URL). Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId/oauth",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The OAuth server to sign in to"),
    format: z
      .enum(["redirect", "json"])
      .optional()
      .describe(
        "redirect (the default) sends the browser on; json answers the URL",
      ),
  });

  /**
   * @param tx - The transaction the stored client and its audit row share.
   * @param params - The inputs.
   * @param connection - The admin's connection.
   * @returns A redirect, or the authorization URL.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerOauthStart>,
    connection: AuditedConnection,
  ) {
    const server = await loadMcpServer(
      tx,
      params.projectId,
      params.mcpServerId,
    );
    const { authorizationUrl, client } = await startSignIn(
      tx,
      server,
      connection.session?.data.userId as number,
    );
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = server.name;
    connection.metadata.auditBefore = serializeMcpServer(server);
    connection.metadata.auditMetadata = {
      mcpServerId: server.id,
      issuer: client.issuer,
      authorizationEndpoint: client.authorizationEndpoint,
    };
    if (params.format === "json") return { authorizationUrl };
    return new Response(null, {
      status: 302,
      headers: { location: authorizationUrl },
    });
  }
}
