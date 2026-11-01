import { z } from "zod";
import { memoryPathPrefixInput } from "../ops/MemoryChunkOps";
import { touchDocuments } from "../ops/MemoryOps";
import { searchMemory } from "../ops/MemorySearchOps";
import { readSetOf, scopeChoiceInput } from "./memory-shared";
import type { ToolDefinition } from "./types";

/** The most hits one search returns. */
const MAX_LIMIT = 25;

/** How many of the top hits count as used, slowing their decay. */
const TOUCHED = 3;

const input = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("What to find, in words: a question, a name, a topic"),
  scope: scopeChoiceInput,
  pathPrefix: memoryPathPrefixInput.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many hits, at most ${MAX_LIMIT} (default 10)`),
});

const output = z.object({
  hits: z.array(
    z.object({
      path: z.string(),
      scope: z.enum(["channel", "project"]),
      versionId: z.number(),
      snippet: z.string(),
      score: z.number(),
      description: z.string(),
    }),
  ),
  mode: z.enum(["hybrid", "keyword"]),
});

/**
 * `memory_search` — hybrid semantic and keyword search over this channel's
 * memory and the project's. Replay safe: it reads, and bumping the top hits'
 * last use is harmless to repeat.
 */
export const memorySearch: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_search",
  description:
    "Search what you remember: this channel's memory (shared by every bot working here) and the project's shared memory. Ranks by meaning and by keywords, and favors what was written or used recently. Search before you answer from memory and before you write a new memory, so you update instead of duplicating. Then memory_read a hit for its full text. [[ bash equivalent command: grep -r ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const result = await searchMemory(ctx.db, readSetOf(ctx), args.query, {
      scope: args.scope ?? "both",
      pathPrefix: args.pathPrefix || undefined,
      limit: args.limit ?? 10,
      signal: ctx.signal,
    });
    await touchDocuments(
      ctx.db,
      result.hits.slice(0, TOUCHED).map((h) => h.documentId),
    );
    return {
      hits: result.hits.map((h) => ({
        path: h.path,
        scope: h.scope,
        versionId: h.versionId,
        snippet: h.snippet,
        score: h.score,
        description: h.description,
      })),
      mode: result.mode,
    };
  },
};
