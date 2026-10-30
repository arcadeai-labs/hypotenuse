import { z } from "zod";
import {
  applyLinePatches,
  linePatchInput,
  memoryPathInput,
} from "../ops/MemoryChunkOps";
import { botWrite, notFound, scopeInput } from "./memory-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  path: memoryPathInput,
  scope: scopeInput,
  patches: z
    .array(linePatchInput)
    .min(1)
    .max(50)
    .describe(
      "Line-range replacements, by the line numbers memory_read showed",
    ),
  changeNote: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why you are changing it, in a sentence"),
  baseVersionId: z
    .number()
    .int()
    .positive()
    .describe(
      "The versionId memory_read returned; the edit is refused if it is no longer current",
    ),
});

const output = z.object({
  path: z.string(),
  scope: z.enum(["channel", "project"]),
  versionId: z.number(),
});

/**
 * `memory_edit` — patch lines of a memory document, as a new version, only if
 * the version the patches were written against is still current. Unsafe to
 * replay; a retried call returns the version it already wrote.
 */
export const memoryEdit: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_edit",
  description:
    "Change lines of a memory document without rewriting it: each patch replaces start_line through end_line (as memory_read numbered them) with content; end_line 0 inserts before start_line; empty content deletes. Pass the versionId you read as baseVersionId: if someone changed the document since, the edit is refused and you read it again. [[ bash equivalent command: sed -i ]]",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    const { row } = await botWrite(ctx, args.scope, args.path, (current) => {
      if (!current || current.tombstone) throw notFound(args.path, args.scope);
      const currentId = current.versionId.getTime();
      if (currentId !== args.baseVersionId) {
        throw new ToolError(
          "version_conflict",
          `"${args.path}" changed since version ${args.baseVersionId}; the current version is ${currentId}.`,
          `Call memory_read for "${args.path}" again and make your edit against versionId ${currentId}.`,
        );
      }
      let content: string;
      try {
        content = applyLinePatches(current.content, args.patches);
      } catch (error) {
        throw new ToolError(
          "invalid_patch",
          error instanceof Error ? error.message : String(error),
          "Read the document again for its line numbers, and send patches that do not overlap.",
        );
      }
      return { content, changeNote: args.changeNote };
    });
    return {
      path: row.logicalPath,
      scope: row.scope,
      versionId: row.versionId.getTime(),
    };
  },
};
