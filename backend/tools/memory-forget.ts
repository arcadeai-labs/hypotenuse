import { z } from "zod";
import { memoryPathInput } from "../ops/MemoryChunkOps";
import { botWrite, notFound, scopeInput } from "./memory-shared";
import type { ToolDefinition } from "./types";

const input = z.object({
  path: memoryPathInput,
  scope: scopeInput,
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why it should be forgotten: wrong, outdated, or asked to"),
});

const output = z.object({
  path: z.string(),
  scope: z.enum(["channel", "project"]),
  versionId: z.number(),
});

/**
 * `memory_forget` — tombstone a memory document. Its history is kept for
 * people to review; search and lists stop showing it. Unsafe to replay; a
 * retried call returns the tombstone it already wrote.
 */
export const memoryForget: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_forget",
  description:
    "Forget a memory document that is wrong, outdated, or that someone asked you to forget. It stops appearing in search and lists; people can still see its history. [[ bash equivalent command: rm ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    const { row } = await botWrite(ctx, args.scope, args.path, (current) => {
      if (!current || current.tombstone) throw notFound(args.path, args.scope);
      return { content: "", tombstone: true, changeNote: args.reason };
    });
    return {
      path: row.logicalPath,
      scope: row.scope,
      versionId: row.versionId.getTime(),
    };
  },
};
