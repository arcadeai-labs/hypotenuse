import { config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/memory";
import { DESCRIPTION_MAX_CHARS, memoryPathInput } from "../ops/MemoryChunkOps";
import { botWrite, scopeInput } from "./memory-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  path: memoryPathInput,
  scope: scopeInput,
  content: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "The whole document, as markdown. It replaces what the path held",
    ),
  description: z
    .string()
    .max(DESCRIPTION_MAX_CHARS)
    .optional()
    .describe(
      `One line saying what the document is about, at most ${DESCRIPTION_MAX_CHARS} characters; search and lists show it`,
    ),
  changeNote: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why you are writing it, in a sentence"),
});

const output = z.object({
  path: z.string(),
  scope: z.enum(["channel", "project"]),
  versionId: z.number(),
});

/**
 * `memory_write` — write a whole memory document as a new version. Unsafe to
 * replay; a retried call with the same `toolCallId` returns the version it
 * already wrote.
 */
export const memoryWrite: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "memory_write",
  description:
    'Remember something: write a whole markdown document at a path, as a new version (earlier versions are kept). Use scope "channel" for what you learned here — every bot working in this channel will see it, and no other channel will. Project memory is shared with every bot in every channel and changes only when a person promotes something there. Search first and update an existing document rather than starting a near-duplicate; prefer memory_edit for small changes. [[ bash equivalent command: cat > file ]]',
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    if (args.content.length > config.memory.maxDocumentChars) {
      throw new ToolError(
        "too_large",
        `A memory document holds at most ${config.memory.maxDocumentChars} characters; this one has ${args.content.length}.`,
        "Split it into several documents under one folder, such as people/alex/.",
      );
    }
    const { row } = await botWrite(ctx, args.scope, args.path, () => ({
      content: args.content,
      description: args.description,
      changeNote: args.changeNote,
    }));
    return {
      path: row.logicalPath,
      scope: row.scope,
      versionId: row.versionId.getTime(),
    };
  },
};
