/**
 * `hypotenuse bot tools` — which of the project's MCP servers a bot may use
 * (`bot-mcp-server:*`), the allowlist patterns naming the calls it makes
 * without asking, and whether read-only tools run without approval.
 */
import type { Command } from "commander";
import { resolveBotId, resolveMcpServerId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  withPaging,
} from "../context";
import { collect } from "../input";
import { table } from "../output/theme";

/** A bot's use of one server, as the binding actions answer it. */
export interface BotMcpServer {
  id: number;
  botId: number;
  mcpServerId: number;
  server: {
    id: number;
    name: string;
    status: string;
    enabled: boolean;
    toolCount: number;
  };
  allowedTools: string[];
  autoAllowReadOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * The allowlist as a person reads it.
 * @param patterns - The binding's patterns.
 * @returns The rendering.
 */
export function allowText(patterns: readonly string[]): string {
  return patterns.length === 0 ? "(every call asks)" : patterns.join(", ");
}

/**
 * Register `bot tools list|add|remove` under `bot`.
 * @param bot - The `bot` command.
 */
export function registerBotToolsCommands(bot: Command): void {
  const tools = bot
    .command("tools")
    .description(
      "The MCP servers a bot may use and which calls skip approval: list|add|remove",
    );

  withPaging(
    tools
      .command("list")
      .description(
        "List a bot's MCP servers, its allowlists, and the summary of what its tools can do",
      )
      .argument("<bot>", "id or slug"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, selector);
      const result = await client.request<
        Paginated<"botMcpServers", BotMcpServer> & {
          capabilities: string | null;
        }
      >("GET", `/project/${projectId}/bot/${botId}/mcp-servers`, {
        query: pageQuery(this),
      });
      emit(ctx, result, () => {
        const rows = table(
          result.botMcpServers.map((b) => ({
            server: b.server.name,
            status: b.server.enabled ? b.server.status : "disabled",
            tools: b.server.toolCount,
            allowed: allowText(b.allowedTools),
            "read-only": b.autoAllowReadOnly ? "runs" : "asks",
          })),
          [
            { key: "server", maxWidth: 30 },
            { key: "status" },
            { key: "tools" },
            { key: "allowed", maxWidth: 50 },
            { key: "read-only" },
          ],
        );
        const summary = result.capabilities ? `\n\n${result.capabilities}` : "";
        return rows + pageFooter(result.pagination) + summary;
      });
    });
  });

  tools
    .command("add")
    .description(
      "Give a bot one of the project's MCP servers, or change its settings for it (write access)",
    )
    .argument("<bot>", "id or slug")
    .argument("<server>", "the MCP server's id or name")
    .option(
      "--allow <pattern>",
      "a call that runs without approval: server/tool, server/*, */tool, a tool name, or /regex/ (repeatable; replaces the list)",
      collect,
    )
    .option(
      "--no-allow",
      "clear the allowlist, so every call (but read-only ones, when allowed) asks",
    )
    .option(
      "--auto-allow-read-only",
      "let tools the server marks read-only run without approval",
    )
    .option(
      "--no-auto-allow-read-only",
      "read-only tools ask like any other (the default)",
    )
    .action(async function (
      this: Command,
      botSelector: string,
      serverSelector: string,
    ) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as {
          allow?: string[] | false;
          autoAllowReadOnly?: boolean;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, botSelector);
        const mcpServerId = await resolveMcpServerId(
          client,
          projectId,
          serverSelector,
        );
        const body: Record<string, unknown> = { mcpServerId };
        if (o.allow === false) body.allowedTools = [];
        else if (o.allow !== undefined) body.allowedTools = o.allow;
        if (o.autoAllowReadOnly !== undefined) {
          body.autoAllowReadOnly = o.autoAllowReadOnly;
        }
        const result = await client.request<{ botMcpServer: BotMcpServer }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/mcp-server`,
          { body },
        );
        const b = result.botMcpServer;
        emit(
          ctx,
          result,
          () =>
            `${b.server.name}: allowed ${allowText(b.allowedTools)}; read-only tools ${b.autoAllowReadOnly ? "run without approval" : "ask"}`,
        );
      });
    });

  tools
    .command("remove")
    .description("Take an MCP server away from a bot (write access)")
    .argument("<bot>", "id or slug")
    .argument("<server>", "the MCP server's id or name")
    .action(async function (
      this: Command,
      botSelector: string,
      serverSelector: string,
    ) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, botSelector);
        const mcpServerId = await resolveMcpServerId(
          client,
          projectId,
          serverSelector,
        );
        const result = await client.request<{ botMcpServer: BotMcpServer }>(
          "DELETE",
          `/project/${projectId}/bot/${botId}/mcp-server/${mcpServerId}`,
        );
        emit(
          ctx,
          result,
          () => `Removed ${result.botMcpServer.server.name} from the bot`,
        );
      });
    });
}
