import { z } from "zod";
import { botServers, findServer, visibleTools } from "../ops/McpCatalogOps";
import { oneLine } from "./mcp-search";
import { hasServers } from "./mcp-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  server: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe("The server's name, the part before the slash in server/tool"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many tools (default 0)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many tools to return (default 50)"),
});

const output = z.object({
  server: z.string(),
  total: z.number(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      needsApproval: z.boolean(),
    }),
  ),
  nextOffset: z.number().nullable(),
});

/**
 * `mcp_list_tools` — list one server's tools, a page at a time. Safe to replay.
 */
export const mcpListTools: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "mcp_list_tools",
  description:
    "List the tools one of your MCP servers offers, a page at a time, as server/tool with a one-line description. Prefer mcp_search when you know what you want to do.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasServers,
  run: async (args, ctx) => {
    const servers = await botServers(ctx.db, ctx.bot.id);
    const found = findServer(servers, args.server);
    if (!found) {
      throw new ToolError(
        "not_found",
        `You have no MCP server named "${args.server}".${servers.length ? ` Yours: ${servers.map((s) => s.server.name).join(", ")}.` : ""}`,
        "Use one of your servers' names, or mcp_search.",
      );
    }
    const tools = visibleTools([found]);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const page = tools.slice(offset, offset + limit);
    return {
      server: args.server,
      total: tools.length,
      tools: page.map((t) => ({
        name: `${t.server}/${t.tool.name}`,
        description: oneLine(t.tool.description),
        needsApproval: t.gated,
      })),
      nextOffset: offset + limit < tools.length ? offset + limit : null,
    };
  },
};
