import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { pageOf, parseLargeResultRef } from "../ops/LargeResultOps";
import { largeResults } from "../schema/large_results";
import { hasServers } from "./mcp-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  id: z
    .string()
    .trim()
    .describe("The result's id, lr_<number>, from a truncated tool result"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The first character to read (default 0)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .optional()
    .describe("How many characters to read (default 10000)"),
});

const output = z.object({
  id: z.string(),
  offset: z.number(),
  totalChars: z.number(),
  text: z.string(),
  nextOffset: z.number().nullable(),
});

/**
 * `read_large_result` — page through a tool result that was too long to show
 * whole. Only this conversation's results. Safe to replay.
 */
export const readLargeResult: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "read_large_result",
  description:
    "Read part of a tool result that was too long to show whole, by its id (lr_<number>) and a character offset. Keep reading from nextOffset until it is null, or stop when you have what you need.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasServers,
  run: async (args, ctx) => {
    const id = parseLargeResultRef(args.id);
    const [row] =
      id === null
        ? []
        : await ctx.db
            .select()
            .from(largeResults)
            .where(
              and(
                eq(largeResults.id, id),
                eq(largeResults.conversationId, ctx.conversation.id),
              ),
            )
            .limit(1);
    if (!row) {
      throw new ToolError(
        "not_found",
        `There is no large result ${args.id} in this conversation.`,
        "Use the id from a truncated result in this conversation.",
      );
    }
    return pageOf(row, args.offset ?? 0, args.limit ?? 10_000);
  },
};
