import { z } from "zod";
import { memoryPathPrefixInput } from "../ops/MemoryChunkOps";
import { listDocuments } from "../ops/MemoryOps";
import { readSetOf, scopeChoiceInput } from "./memory-shared";
import type { ToolDefinition } from "./types";

/** The most documents one call lists. */
const MAX_LIMIT = 100;

const input = z.object({
  scope: scopeChoiceInput,
  pathPrefix: memoryPathPrefixInput.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many documents, at most ${MAX_LIMIT} (default 50)`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many (the nextOffset a list returned)"),
});

const output = z.object({
  documents: z.array(
    z.object({
      path: z.string(),
      scope: z.enum(["channel", "project"]),
      description: z.string(),
      versionId: z.number(),
      updatedAt: z.number(),
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
});

/**
 * `memory_list` — the documents in this channel's memory and the project's,
 * by path. Replay safe: it only reads.
 */
export const memoryList: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_list",
  description:
    "List the documents you remember, by path, with each one's description: this channel's memory and the project's shared memory. Use a pathPrefix such as people/ or facts/ to look in one folder. [[ bash equivalent command: ls -R ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const { rows, total } = await listDocuments(
      ctx.db,
      readSetOf(ctx),
      args.scope ?? "both",
      { pathPrefix: args.pathPrefix || undefined, limit, offset },
    );
    return {
      documents: rows.map((r) => ({
        path: r.logicalPath,
        scope: r.scope,
        description: r.description,
        versionId: r.versionId.getTime(),
        updatedAt: r.createdAt.getTime(),
      })),
      total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  },
};
