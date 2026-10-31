import { z } from "zod";
import { memoryList } from "../../tools/memory-list";
import { memorySearch } from "../../tools/memory-search";
import {
  botWrite,
  notFound,
  readSetOf,
  scopeChoiceInput,
  scopeInput,
} from "../../tools/memory-shared";
import { ToolError } from "../../tools/types";
import { memoryPathInput, memoryPathPrefixInput } from "../MemoryChunkOps";
import { keyIn, readVersion, touchDocuments } from "../MemoryOps";
import {
  type HostFunctionDef,
  type HostScope,
  hostToolContext,
} from "./host-shared";

/**
 * `memory.*` in a program: the memory tools' own ops and read set, so a
 * program sees exactly the channel and project memory the conversation does
 * — another channel's path is not found, by construction — and writes only
 * channel memory, as a bot always does.
 */

/** The most hits `memory.search` returns. */
const MAX_SEARCH_HITS = 20;

/** The most characters one `memory.write` stores. */
const MAX_WRITE_CHARS = 100_000;

/**
 * Validate a tool's input with its own schema, as the tick would.
 * @param schema - The tool's input schema.
 * @param input - The arguments.
 * @param fn - The guest-facing name, for the message.
 * @returns The parsed input.
 * @throws {ToolError} `invalid_arguments`.
 */
export function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
  fn: string,
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ToolError(
    "invalid_arguments",
    `${fn}: ${parsed.error.issues
      .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
      .join("; ")}`,
    'Read the API with run_code and source "?", then call it with arguments that match.',
  );
}

const searchOptions = z
  .object({
    scope: scopeChoiceInput,
    pathPrefix: memoryPathPrefixInput.optional(),
    limit: z.number().int().positive().max(MAX_SEARCH_HITS).optional(),
  })
  .strict();

const listOptions = z
  .object({
    scope: scopeChoiceInput,
    pathPrefix: memoryPathPrefixInput.optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const readOptions = z.object({ scope: scopeInput.optional() }).strict();

const writeOptions = z
  .object({
    scope: scopeInput.optional(),
    changeNote: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(240).optional(),
  })
  .strict();

/**
 * Read one document's current text: parsed JSON for a `.json` path.
 * @param scope - Where it runs.
 * @param path - The path.
 * @param memoryScope - `channel` (default) or `project`.
 * @returns The text or value.
 */
async function readDocument(
  scope: HostScope,
  path: string,
  memoryScope: "channel" | "project",
): Promise<unknown> {
  const { ctx } = scope;
  const row = await readVersion(
    ctx.db,
    keyIn(readSetOf(ctx), memoryScope, path),
  );
  if (!row) throw notFound(path, memoryScope);
  if (row.tombstone) {
    throw new ToolError(
      "forgotten",
      `"${path}" was forgotten.`,
      "It is no longer part of memory.",
    );
  }
  await touchDocuments(ctx.db, [row.id]);
  if (path.endsWith(".json")) {
    try {
      return JSON.parse(row.content.replace(/^```json\n|\n```$/g, ""));
    } catch {
      return row.content;
    }
  }
  return row.content;
}

/** The `memory_*` host functions. */
export const memoryHost: Record<string, HostFunctionDef> = {
  memory_search: {
    fn: "memory.search",
    args: z.tuple([z.string(), searchOptions.optional()]),
    body: async (scope, [query, options]) => {
      const o = (options ?? {}) as z.infer<typeof searchOptions>;
      const input = parseWith(
        memorySearch.inputSchema,
        { query, ...o, limit: o.limit ?? 10 },
        "memory.search",
      );
      const out = await memorySearch.run(input, scope.ctx);
      return { value: out };
    },
  },
  memory_list: {
    fn: "memory.list",
    args: z.tuple([listOptions.optional()]),
    body: async (scope, [options]) => {
      const input = parseWith(
        memoryList.inputSchema,
        options ?? {},
        "memory.list",
      );
      return { value: await memoryList.run(input, scope.ctx) };
    },
  },
  memory_read: {
    fn: "memory.read",
    args: z.tuple([memoryPathInput, readOptions.optional()]),
    body: async (scope, [path, options]) => {
      const p = path as string;
      const memoryScope =
        (options as z.infer<typeof readOptions> | undefined)?.scope ??
        "channel";
      return { name: p, value: await readDocument(scope, p, memoryScope) };
    },
  },
  memory_write: {
    fn: "memory.write",
    args: z.tuple([memoryPathInput, z.unknown(), writeOptions.optional()]),
    body: async (scope, [path, value, options]) => {
      const p = path as string;
      const o = (options ?? {}) as z.infer<typeof writeOptions>;
      const content =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (content === undefined || content.length === 0) {
        throw new ToolError(
          "invalid_arguments",
          "memory.write needs something to write.",
          "Pass a string, or a value that serializes to JSON.",
        );
      }
      if (content.length > MAX_WRITE_CHARS) {
        throw new ToolError(
          "too_large",
          `That is ${content.length} characters; one memory document holds ${MAX_WRITE_CHARS}.`,
          "Write less: reduce it first, or split it across paths.",
        );
      }
      const { row } = await botWrite(
        hostToolContext(scope),
        o.scope ?? "channel",
        p,
        () => ({
          content,
          ...(o.description ? { description: o.description } : {}),
          changeNote: o.changeNote ?? "Written by run_code",
        }),
      );
      return {
        name: p,
        value: {
          path: row.logicalPath,
          scope: row.scope,
          versionId: row.versionId.getTime(),
          bytesWritten: Buffer.byteLength(content, "utf8"),
        },
      };
    },
  },
};
