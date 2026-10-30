import { z } from "zod";
import { botServers, searchCatalog } from "../ops/McpCatalogOps";
import { hasServers } from "./mcp-shared";
import type { ToolDefinition } from "./types";

const input = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("What you want to do, in plain words, e.g. 'send an email'"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("How many tools to return (default 8)"),
});

const output = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      needsApproval: z.boolean(),
      score: z.number(),
    }),
  ),
  searchedBy: z.enum(["keyword", "keyword+semantic"]),
});

/**
 * `mcp_search` — find tools across the bot's MCP servers by what they do.
 * Safe to replay.
 */
export const mcpSearch: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "mcp_search",
  description:
    "Find tools on your MCP servers by what they do. Returns each match as server/tool with a one-line description and whether calling it waits for a person's approval. Then call mcp_info on the one you want before mcp_exec.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasServers,
  run: async (args, ctx) => {
    const servers = await botServers(ctx.db, ctx.bot.id);
    const { hits, semantic } = await searchCatalog(
      ctx.bot.projectId,
      servers,
      args.query,
      args.limit ?? 8,
      ctx.signal,
    );
    return {
      tools: hits.map((h) => ({
        name: `${h.server}/${h.tool.name}`,
        description: oneLine(h.tool.description),
        needsApproval: h.gated,
        score: h.score,
      })),
      searchedBy: semantic ? "keyword+semantic" : "keyword",
    };
  },
};

/**
 * The first line of a description, at most 200 characters.
 * @param text - The description.
 * @returns One line.
 */
export function oneLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line.trim();
}
