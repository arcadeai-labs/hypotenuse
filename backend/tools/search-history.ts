import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { entryText } from "../ops/TranscriptOps";
import { conversationEntries } from "../schema/conversation_entries";
import type { ToolDefinition } from "./types";

/** The most entries one call returns. */
const MAX_RESULTS = 20;

/** How much of each entry's text a result carries. */
const EXCERPT_CHARS = 500;

const input = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Text to find, case-insensitive. Omit it to read from offset"),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Read from this seq on (the seq a search returned)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_RESULTS)
    .optional()
    .describe(`How many entries to return, at most ${MAX_RESULTS}`),
});

const output = z.object({
  entries: z.array(
    z.object({
      seq: z.number(),
      kind: z.string(),
      role: z.string().nullable(),
      toolName: z.string().nullable(),
      text: z.string(),
    }),
  ),
  nextOffset: z.number().nullable(),
});

/**
 * `search_history` — find or read this conversation's earlier entries,
 * including the ones a compaction summarized. Replay safe: it only reads.
 */
export const searchHistory: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "search_history",
  description:
    "Search this conversation's full history, including what an earlier summary replaced. With query, finds entries containing that text and returns their seq; with offset, reads entries from that seq on. Use it to recover exact wording you no longer see.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const limit = args.limit ?? 10;
    const conditions = [
      eq(conversationEntries.conversationId, ctx.conversation.id),
    ];
    if (args.offset !== undefined) {
      conditions.push(gte(conversationEntries.seq, args.offset));
    }
    if (args.query !== undefined) {
      const pattern = `%${args.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        sql`${conversationEntries.content}::text ilike ${pattern}`,
      );
    }
    const rows = await ctx.db
      .select()
      .from(conversationEntries)
      .where(and(...conditions))
      .orderBy(asc(conversationEntries.seq))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      entries: page.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        role: row.role,
        toolName: row.toolName,
        text: entryText(row).slice(0, EXCERPT_CHARS),
      })),
      nextOffset: rows.length > limit ? rows[limit].seq : null,
    };
  },
};
