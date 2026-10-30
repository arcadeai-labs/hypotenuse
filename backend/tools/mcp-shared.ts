import { api } from "keryx";
import { z } from "zod";
import {
  type BotServer,
  botHasServers,
  botServers,
  findServer,
  findTool,
} from "../ops/McpCatalogOps";
import type { McpCatalogTool } from "../schema/mcp_servers";
import { type ToolContext, ToolError } from "./types";

/**
 * What the MCP meta-tools share: who sees them, and how a `server/tool` name
 * resolves against the bot's servers.
 */

/** The input naming one tool. */
export const toolNameInput = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/[^/\s]+$/, "Name a tool as server/tool")
  .describe("The tool, as server/tool — the name mcp_search returns");

/**
 * Offered only to a bot with at least one enabled MCP server.
 * @param ctx - The bot.
 * @returns `true` when the bot has servers.
 */
export function hasServers(ctx: Pick<ToolContext, "bot">): Promise<boolean> {
  return botHasServers(api.db.db, ctx.bot.id);
}

/**
 * Resolve `server/tool` against the bot's servers.
 * @param ctx - The call's context.
 * @param name - `server/tool`.
 * @returns The server, its binding, and the cached tool.
 * @throws {ToolError} `not_found` naming what to do.
 */
export async function resolveTool(
  ctx: Pick<ToolContext, "bot" | "db">,
  name: string,
): Promise<BotServer & { tool: McpCatalogTool; name: string }> {
  const [serverName, toolName] = name.split("/");
  const servers = await botServers(ctx.db, ctx.bot.id);
  const found = findServer(servers, serverName);
  if (!found) {
    throw new ToolError(
      "not_found",
      `You have no MCP server named "${serverName}".${servers.length ? ` Yours: ${servers.map((s) => s.server.name).join(", ")}.` : ""}`,
      "Call mcp_search to find a tool by what it does.",
    );
  }
  const tool = findTool(found.server, toolName);
  if (!tool) {
    throw new ToolError(
      "not_found",
      `${serverName} has no tool named "${toolName}".`,
      `Call mcp_search, or mcp_list_tools with server "${serverName}", to find the right one.`,
    );
  }
  return { ...found, tool, name: `${serverName}/${toolName}` };
}
