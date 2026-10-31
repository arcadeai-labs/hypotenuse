import { z } from "zod";
import { botServers, findServer, visibleTools } from "../ops/McpCatalogOps";
import { oneLine } from "./mcp-search";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  server: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Only this server's tools — the part before the slash in server/tool. Leave it out to list every server's",
    ),
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
  server: z.string().nullable(),
  servers: z.array(z.object({ name: z.string(), tools: z.number() })),
  total: z.number(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      needsApproval: z.boolean(),
    }),
  ),
  nextOffset: z.number().nullable(),
  note: z.string().optional(),
});

/** What a bot with no MCP server is told, so it says so instead of guessing. */
export const NO_SERVERS_NOTE =
  "You have no MCP servers, so no MCP tools: only your built-in tools. A project admin attaches servers to you on your Tools tab.";

/**
 * `mcp_list_tools` — the MCP tools the bot can call, a page at a time: every
 * server's, or one server's. Offered to every bot, so one call answers "what
 * can you do?" even for a bot with no server — without it, that bot would
 * have to reach for `run_code` to learn it has nothing. Safe to replay.
 */
export const mcpListTools: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "mcp_list_tools",
  description:
    "List the MCP tools you can call, as server/tool with a one-line description, a page at a time — every server's, or one server's. Call it when asked what tools you have. Prefer mcp_search when you know what you want to do.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => Promise.resolve(true),
  run: async (args, ctx) => {
    const servers = await botServers(ctx.db, ctx.bot.id);
    let listed = servers;
    if (args.server !== undefined) {
      const found = findServer(servers, args.server);
      if (!found) {
        throw new ToolError(
          "not_found",
          servers.length
            ? `You have no MCP server named "${args.server}". Yours: ${servers.map((s) => s.server.name).join(", ")}.`
            : `You have no MCP server named "${args.server}". ${NO_SERVERS_NOTE}`,
          servers.length
            ? "Use one of your servers' names, leave server out to list them all, or mcp_search."
            : "Do not look for MCP tools; say you have none.",
        );
      }
      listed = [found];
    }
    const tools = visibleTools(listed);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const page = tools.slice(offset, offset + limit);
    return {
      server: args.server ?? null,
      servers: servers.map((s) => ({
        name: s.server.name,
        tools: s.server.toolsCache.length,
      })),
      total: tools.length,
      tools: page.map((t) => ({
        name: `${t.server}/${t.tool.name}`,
        description: oneLine(t.tool.description),
        needsApproval: t.gated,
      })),
      nextOffset: offset + limit < tools.length ? offset + limit : null,
      ...(servers.length ? {} : { note: NO_SERVERS_NOTE }),
    };
  },
};
