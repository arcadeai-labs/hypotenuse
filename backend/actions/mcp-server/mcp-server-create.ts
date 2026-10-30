import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { refreshCatalog } from "../../ops/McpCatalogOps";
import {
  assertCredentialsFit,
  assertServerNameFree,
  assertUsableServerUrl,
  bearerTokenInput,
  mcpAuthModeInput,
  mcpHeadersInput,
  mcpServerNameInput,
  mcpServerUrlInput,
  mcpTimeoutInput,
  oauthClientIdInput,
  oauthClientSecretInput,
  sealCredentials,
  sealJson,
  serializeMcpServer,
} from "../../ops/McpServerOps";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:create` — connect an MCP server to a project. Requires admin
 * standing. Credentials are sealed before they are written and never
 * returned. A server that does not need a sign-in is connected at once and
 * its tools listed; an OAuth server waits for `mcp-server:oauth-start`.
 */
export class McpServerCreate extends AuditedAction {
  name = "mcp-server:create";
  description =
    "Connect an MCP server (Streamable HTTP) to a project for its bots: a name, its URL, and how it authenticates — none, static headers, a bearer token, or OAuth. Credentials are encrypted and never returned. Connects once and lists its tools (an OAuth server waits for an admin to sign in from the dashboard). Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/mcp-server", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project"),
    name: mcpServerNameInput,
    url: mcpServerUrlInput,
    authMode: mcpAuthModeInput,
    headers: mcpHeadersInput.optional(),
    bearerToken: bearerTokenInput.optional(),
    clientId: oauthClientIdInput.optional(),
    clientSecret: oauthClientSecretInput.optional(),
    timeoutMs: mcpTimeoutInput.optional(),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The server, without its credentials.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerCreate>,
    connection: AuditedConnection,
  ) {
    await assertUsableServerUrl(params.url);
    assertCredentialsFit(params.authMode, params);
    await assertServerNameFree(tx, params.projectId, params.name);
    const [row] = await tx
      .insert(mcpServers)
      .values({
        projectId: params.projectId,
        name: params.name,
        url: params.url,
        authMode: params.authMode,
        ...sealCredentials(params.authMode, params),
        oauthClient:
          params.authMode === "oauth" && params.clientId
            ? sealJson({
                clientId: params.clientId,
                clientSecret: params.clientSecret,
                issuer: "",
                authorizationEndpoint: "",
                tokenEndpoint: "",
                resource: params.url,
              })
            : null,
        timeoutMs: params.timeoutMs ?? null,
        status: params.authMode === "oauth" ? "needs_auth" : "ok",
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();
    const final =
      params.authMode === "oauth"
        ? row
        : (await refreshCatalog(row, tx)).server;
    const serialized = serializeMcpServer(final);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = final.name;
    return { mcpServer: serialized };
  }
}
