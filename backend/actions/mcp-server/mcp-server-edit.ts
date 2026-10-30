import { eq, sql } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
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
import { retireServerClients } from "../../ops/McpClientOps";
import {
  assertCredentialsFit,
  assertServerNameFree,
  assertUsableServerUrl,
  bearerTokenInput,
  loadMcpServer,
  mcpAuthModeInput,
  mcpHeadersInput,
  mcpServerNameInput,
  mcpServerUrlInput,
  mcpTimeoutInput,
  oauthClientIdInput,
  oauthClientSecretInput,
  openCredentials,
  sealCredentials,
  sealJson,
  serializeMcpServer,
} from "../../ops/McpServerOps";
import { type McpServer, mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:edit` — change a server: its name, URL, auth mode,
 * credentials, timeout, or whether it is enabled. Requires admin standing. A
 * change to the URL or any credential bumps the credential version, which
 * retires every pooled client, and reconnects.
 */
export class McpServerEdit extends AuditedAction {
  name = "mcp-server:edit";
  description =
    "Edit an MCP server: its name, URL, auth mode, credentials (headers, bearer token, or OAuth client), per-call timeout, or enabled flag. Only the fields sent change. Changing the URL or credentials reconnects and re-lists its tools; changing the auth mode to oauth needs a new sign-in. Credentials are never returned. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server to edit"),
    name: mcpServerNameInput.optional(),
    url: mcpServerUrlInput.optional(),
    authMode: mcpAuthModeInput.optional(),
    headers: mcpHeadersInput.optional(),
    bearerToken: bearerTokenInput.optional(),
    clientId: oauthClientIdInput.optional(),
    clientSecret: oauthClientSecretInput.optional(),
    timeoutMs: mcpTimeoutInput.nullable().optional(),
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Whether bots may use it; a disabled server is invisible to them",
      ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The server.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerEdit>,
    connection: AuditedConnection,
  ) {
    const before = await loadMcpServer(
      tx,
      params.projectId,
      params.mcpServerId,
    );
    connection.metadata.auditBefore = serializeMcpServer(before);
    if (params.name !== undefined)
      await assertServerNameFree(tx, params.projectId, params.name, before.id);
    if (params.url !== undefined) await assertUsableServerUrl(params.url);

    const authMode = params.authMode ?? before.authMode;
    const modeChanged = authMode !== before.authMode;
    const credentialsSent =
      params.headers !== undefined ||
      params.bearerToken !== undefined ||
      params.clientId !== undefined;
    if (modeChanged || credentialsSent) {
      if (authMode === "headers" || authMode === "bearer")
        assertCredentialsFit(authMode, params);
    }
    const urlChanged = params.url !== undefined && params.url !== before.url;
    const reconnect = urlChanged || modeChanged || credentialsSent;

    const set: Partial<McpServer> & Record<string, unknown> = {};
    if (params.name !== undefined) set.name = params.name;
    if (params.url !== undefined) set.url = params.url;
    if (params.timeoutMs !== undefined) set.timeoutMs = params.timeoutMs;
    if (params.enabled !== undefined) set.enabled = params.enabled;
    if (modeChanged || params.headers || params.bearerToken) {
      set.authMode = authMode;
      Object.assign(set, sealCredentials(authMode, params));
    }
    if (
      authMode === "oauth" &&
      (modeChanged || urlChanged || params.clientId)
    ) {
      set.oauthTokens = null;
      set.oauthClient = params.clientId
        ? sealJson({
            clientId: params.clientId,
            clientSecret: params.clientSecret,
            issuer: "",
            authorizationEndpoint: "",
            tokenEndpoint: "",
            resource: params.url ?? before.url,
          })
        : modeChanged || urlChanged
          ? null
          : before.oauthClient;
      set.status = "needs_auth";
    }
    if (authMode !== "oauth" && modeChanged) {
      set.oauthTokens = null;
      set.oauthClient = null;
    }
    // A secret alone rotates the stored client's secret: its id, endpoints,
    // and the sign-in stand, and the next token request uses the new one.
    if (params.clientSecret !== undefined && params.clientId === undefined) {
      const stored = openCredentials(before).oauthClient;
      if (authMode !== "oauth" || modeChanged || urlChanged || !stored) {
        throw new TypedError({
          message:
            authMode !== "oauth"
              ? "clientSecret belongs to an OAuth server."
              : "There is no OAuth client to give this secret to; send clientId with it.",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "clientSecret",
        });
      }
      set.oauthClient = sealJson({
        ...stored,
        clientSecret: params.clientSecret,
      });
    }
    if (reconnect) {
      set.credentialVersion = sql`${mcpServers.credentialVersion} + 1` as never;
    }
    let [row] = await tx
      .update(mcpServers)
      .set(set)
      .where(eq(mcpServers.id, before.id))
      .returning();
    let changedCatalog = false;
    if (reconnect && row.enabled && authMode !== "oauth") {
      const refreshed = await refreshCatalog(row, tx);
      row = refreshed.server;
      changedCatalog = refreshed.changed;
    }
    const serialized = serializeMcpServer(row);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = row.name;
    connection.metadata.afterCommitData = {
      retire: reconnect || params.enabled === false,
      keepVersion: row.enabled ? row.credentialVersion : undefined,
      capabilities:
        changedCatalog ||
        params.enabled !== undefined ||
        params.name !== undefined,
    };
    return { mcpServer: serialized };
  }

  /**
   * Retire the old clients, and regenerate bound bots' capabilities.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - What changed.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<McpServerEdit>,
    connection: AuditedConnection,
  ) {
    const data = connection.metadata.afterCommitData ?? {};
    if (data.retire)
      await retireServerClients(
        params.mcpServerId,
        data.keepVersion as number | undefined,
      );
    if (data.capabilities)
      await enqueueCapabilitiesForServer(params.mcpServerId);
  }
}
