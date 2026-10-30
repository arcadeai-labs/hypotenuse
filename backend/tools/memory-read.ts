import { z } from "zod";
import { memoryPathInput, numberLines } from "../ops/MemoryChunkOps";
import { keyIn, readVersion, touchDocuments } from "../ops/MemoryOps";
import { notFound, readSetOf, scopeInput } from "./memory-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  path: memoryPathInput,
  scope: scopeInput,
  versionId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Read this earlier version (a versionId); omit for the current one",
    ),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The first line to return (1-based)"),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The last line to return, inclusive"),
});

const output = z.object({
  path: z.string(),
  scope: z.enum(["channel", "project"]),
  versionId: z.number(),
  current: z.boolean(),
  description: z.string(),
  content: z.string(),
  totalLines: z.number(),
  pinned: z.boolean(),
  provenance: z.record(z.string(), z.unknown()),
  sourceType: z.string(),
});

/**
 * `memory_read` — one memory document, with line numbers for `memory_edit`.
 * Replay safe: it reads, and counting the read again is harmless.
 */
export const memoryRead: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_read",
  description:
    "Read one memory document in full, each line numbered, with its versionId (needed by memory_edit) and its provenance: the conversation and entries it was learned from, or the person who wrote it. Pass versionId to read an earlier version. [[ bash equivalent command: cat -n ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const row = await readVersion(
      ctx.db,
      keyIn(readSetOf(ctx), args.scope, args.path),
      args.versionId,
    );
    if (!row) {
      if (args.versionId !== undefined) {
        throw new ToolError(
          "not_found",
          `"${args.path}" has no version ${args.versionId}.`,
          "Read it without versionId for the current version.",
        );
      }
      throw notFound(args.path, args.scope);
    }
    if (row.tombstone) {
      throw new ToolError(
        "forgotten",
        `"${args.path}" was forgotten${row.changeNote ? ` (${row.changeNote})` : ""}.`,
        "It is no longer part of memory. Write it again if it is still true.",
      );
    }
    if (row.isCurrent) await touchDocuments(ctx.db, [row.id]);
    const { text, totalLines } = numberLines(
      row.content,
      args.startLine,
      args.endLine,
    );
    return {
      path: row.logicalPath,
      scope: row.scope,
      versionId: row.versionId.getTime(),
      current: row.isCurrent,
      description: row.description,
      content: text,
      totalLines,
      pinned: row.pinned,
      provenance: { ...row.sourceRef },
      sourceType: row.sourceType,
    };
  },
};
