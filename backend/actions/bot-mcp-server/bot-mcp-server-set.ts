import { and, eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  allowedToolsInput,
  assertPatterns,
  autoAllowReadOnlyInput,
  serializeBotMcpServer,
} from "../../ops/BotMcpServerOps";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { enqueueCapabilities } from "../../ops/McpCatalogOps";
import { loadMcpServer } from "../../ops/McpServerOps";
import { botMcpServers } from "../../schema/bot_mcp_servers";

/**
 * `bot-mcp-server:set` — give a bot one of the project's MCP servers, or
 * change which of its tools run without approval. Requires the bot's write
 * access. `autoAllowReadOnly` is an audited decision like any other.
 */
export class BotMcpServerSet extends AuditedAction {
  name = "bot-mcp-server:set";
  description =
    "Give a bot one of the project's MCP servers, or change its settings for it: the allowlist patterns naming calls that run without a person's approval (empty, the default, means every call waits), and whether tools annotated read-only run without approval. Requires the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/mcp-server",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    mcpServerId: idInput("The project's MCP server to give it"),
    allowedTools: allowedToolsInput.optional(),
    autoAllowReadOnly: autoAllowReadOnlyInput.optional(),
  });

  /**
   * @param tx - The transaction the upsert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The binding.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotMcpServerSet>,
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
    if (params.allowedTools) assertPatterns(params.allowedTools);
    const [existing] = await tx
      .select()
      .from(botMcpServers)
      .where(
        and(
          eq(botMcpServers.botId, bot.id),
          eq(botMcpServers.mcpServerId, server.id),
        ),
      )
      .for("update");
    const allowedTools = params.allowedTools
      ? [...new Set(params.allowedTools)]
      : undefined;
    const [row] = existing
      ? await tx
          .update(botMcpServers)
          .set({
            ...(allowedTools ? { allowedTools } : {}),
            ...(params.autoAllowReadOnly !== undefined
              ? { autoAllowReadOnly: params.autoAllowReadOnly }
              : {}),
          })
          .where(eq(botMcpServers.id, existing.id))
          .returning()
      : await tx
          .insert(botMcpServers)
          .values({
            botId: bot.id,
            mcpServerId: server.id,
            allowedTools: allowedTools ?? [],
            autoAllowReadOnly: params.autoAllowReadOnly ?? false,
          })
          .returning();
    const serialized = serializeBotMcpServer(row, server);
    if (existing)
      connection.metadata.auditBefore = serializeBotMcpServer(existing, server);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "bot-mcp-server";
    connection.metadata.auditTargetPath = `${bot.slug}/${server.name}`;
    connection.metadata.afterCommitData = { created: !existing };
    return { botMcpServer: serialized };
  }

  /**
   * A newly given server changes what the bot can do.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Whether it was new.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<BotMcpServerSet>,
    connection: AuditedConnection,
  ) {
    if (connection.metadata.afterCommitData?.created)
      await enqueueCapabilities(params.botId);
  }
}
