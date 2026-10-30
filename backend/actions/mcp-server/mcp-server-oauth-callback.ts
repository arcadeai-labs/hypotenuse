import { eq, sql } from "drizzle-orm";
import {
  type ActionParams,
  config,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/frontend";
import {
  enqueueCapabilitiesForServer,
  refreshCatalog,
} from "../../ops/McpCatalogOps";
import { retireServerClients } from "../../ops/McpClientOps";
import { exchangeCode, takePending } from "../../ops/McpOAuthOps";
import {
  loadMcpServer,
  openCredentials,
  sealJson,
  serializeMcpServer,
} from "../../ops/McpServerOps";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:oauth-callback` — the authorization server sends the admin's
 * browser back here. The `state` names the sign-in (once, for ten minutes),
 * so no session is needed: the admin who started it is the actor. The code is
 * exchanged with the PKCE verifier, the tokens sealed, the credential version
 * bumped, and the tools listed; the browser lands on the MCP servers page. A
 * browser hop, never an MCP tool.
 */
export class McpServerOauthCallback extends AuditedAction {
  name = "mcp-server:oauth-callback";
  description =
    "Where an MCP server's authorization server returns after an admin signs in. Exchanges the code for tokens, stores them encrypted, and redirects to the dashboard.";
  middleware = [RateLimitMiddleware];
  web = { route: "/mcp-server/oauth/callback", method: HTTP_METHOD.GET };
  inputs = z.object({
    state: secret(z.string().min(8).max(512)).describe("The sign-in's state"),
    code: secret(z.string().min(1).max(4096))
      .optional()
      .describe("The authorization code"),
    error: z.string().max(200).optional().describe("Why the sign-in failed"),
    error_description: z
      .string()
      .max(1000)
      .optional()
      .describe("More about why"),
  });

  /**
   * @param tx - The transaction the tokens and the audit row share.
   * @param params - The inputs.
   * @param connection - The browser's connection (often without a session).
   * @returns A redirect to the dashboard.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown state.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<McpServerOauthCallback>,
    connection: AuditedConnection,
  ) {
    const pending = await takePending(params.state);
    if (!pending) {
      throw new TypedError({
        message:
          "This sign-in link expired or was already used. Start the sign-in again from the MCP servers page.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "state",
      });
    }
    const server = await loadMcpServer(
      tx,
      pending.projectId,
      pending.mcpServerId,
    );
    connection.metadata.auditUserId = pending.userId;
    connection.metadata.auditProjectId = pending.projectId;
    connection.metadata.auditTargetType = "mcp-server";
    connection.metadata.auditTargetPath = server.name;
    connection.metadata.auditBefore = serializeMcpServer(server);

    let failure: string | null = params.error
      ? `The authorization server refused: ${params.error}${params.error_description ? ` (${params.error_description})` : ""}`
      : null;
    let row = server;
    const client = openCredentials(server).oauthClient;
    if (!failure && (!params.code || !client)) {
      failure = "The sign-in returned no code.";
    }
    if (!failure && params.code && client) {
      try {
        const tokens = await exchangeCode(client, pending, params.code);
        [row] = await tx
          .update(mcpServers)
          .set({
            oauthTokens: sealJson(tokens),
            credentialVersion: sql`${mcpServers.credentialVersion} + 1`,
            status: "ok",
            lastError: null,
          })
          .where(eq(mcpServers.id, server.id))
          .returning();
        row = (await refreshCatalog(row, tx)).server;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
    }
    if (failure) {
      [row] = await tx
        .update(mcpServers)
        .set({ status: "needs_auth", lastError: failure.slice(0, 1000) })
        .where(eq(mcpServers.id, server.id))
        .returning();
    }
    connection.metadata.auditAfter = serializeMcpServer(row);
    connection.metadata.auditMetadata = {
      mcpServerId: server.id,
      signedIn: !failure,
      ...(failure ? { error: failure.slice(0, 300) } : {}),
    };
    connection.metadata.afterCommitData = {
      mcpServerId: server.id,
      keepVersion: row.credentialVersion,
    };
    const target = new URL(
      `${config.frontend.url.replace(/\/+$/, "")}/settings/mcp-servers`,
    );
    target.searchParams.set("server", String(server.id));
    if (failure) target.searchParams.set("oauthError", failure.slice(0, 300));
    else target.searchParams.set("signedIn", "1");
    return new Response(null, {
      status: 302,
      headers: { location: target.toString() },
    });
  }

  /**
   * Retire clients built with the old tokens; regenerate capabilities.
   * @param _result - The response.
   * @param _params - The inputs.
   * @param connection - Which server.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<McpServerOauthCallback>,
    connection: AuditedConnection,
  ) {
    const data = connection.metadata.afterCommitData ?? {};
    const id = data.mcpServerId as number;
    await retireServerClients(id, data.keepVersion as number);
    await enqueueCapabilitiesForServer(id);
  }
}
