import { config } from "keryx";
import { z } from "zod";
import {
  encodePath,
  githubGet,
  hasGitHubRepositories,
  REPOSITORY_DESCRIPTION,
  withRepositoryToken,
} from "./github-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  repository: z.string().min(1).describe(REPOSITORY_DESCRIPTION),
  path: z
    .string()
    .default("")
    .describe(
      "The file or directory, from the repository's root (e.g. `src/app.ts`). Empty lists the root.",
    ),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("A branch, tag, or commit SHA. Omit for the default branch."),
});

const output = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    repository: z.string(),
    path: z.string(),
    size: z.number(),
    text: z.string(),
    truncated: z.boolean(),
    note: z.string().optional(),
    url: z.string().optional(),
  }),
  z.object({
    kind: z.literal("dir"),
    repository: z.string(),
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        type: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
]);

/** The most directory entries returned. */
const MAX_ENTRIES = 1_000;

/** GitHub's answer for a file. */
interface ContentsFile {
  type: string;
  path: string;
  size: number;
  encoding?: string;
  content?: string;
  html_url?: string;
}

/** GitHub's answer for one directory entry. */
interface ContentsEntry {
  name: string;
  path: string;
  type: string;
}

/**
 * The longest file this deployment returns, in bytes.
 * @returns `config.github.maxFileBytes`, as a number.
 */
function maxFileBytes(): number {
  const n = Number(config.github.maxFileBytes);
  return Number.isFinite(n) && n > 0 ? n : 200_000;
}

/**
 * Whether bytes look like a binary file: a NUL byte, or not UTF-8.
 * @param bytes - The file's bytes (possibly cut).
 * @param cut - Whether they were cut, so a split last character is not counted.
 * @returns `true` for binary.
 */
function looksBinary(bytes: Buffer, cut: boolean): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      cut ? bytes.subarray(0, Math.max(0, bytes.length - 4)) : bytes,
    );
    return false;
  } catch {
    return true;
  }
}

/**
 * `github_file_read` — read one file of a granted repository as text, or list
 * a directory, server-side and without a sandbox. A file over the
 * deployment's cap is cut, and says so; a binary file is refused.
 */
export const githubFileRead: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "github_file_read",
  description:
    "Read a file from a GitHub repository granted to you, as text, or list a directory (an empty path lists the root). Optionally at a branch, tag, or commit. A long file is cut, and the answer says so; binary files are not returned. Use it to look at code or docs quickly; anything that needs a checkout, a build, running tests, or a change belongs in a sandbox (sandbox_start).",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasGitHubRepositories,
  run: async (args, ctx) =>
    withRepositoryToken(ctx, args.repository, "contents", async (token, t) => {
      const path = args.path.replace(/^\/+|\/+$/g, "");
      const query = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
      const where = `${path || "/"} in ${t.fullName}${args.ref ? ` at ${args.ref}` : ""}`;
      const body = await githubGet<ContentsFile | ContentsEntry[]>(
        token,
        `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/contents/${encodePath(path)}${query}`,
        `There is no ${where}.`,
        "Check the path and ref; list the parent directory with an empty or shorter path to see what is there.",
      );
      if (Array.isArray(body)) {
        return {
          kind: "dir" as const,
          repository: t.fullName,
          path,
          entries: body.slice(0, MAX_ENTRIES).map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
          })),
          truncated: body.length > MAX_ENTRIES,
        };
      }
      if (body.type !== "file") {
        throw new ToolError(
          "not_a_file",
          `${where} is a ${body.type}, not a file.`,
          "Read a regular file, or list a directory.",
        );
      }
      if (body.encoding !== "base64" || typeof body.content !== "string") {
        throw new ToolError(
          "file_too_large",
          `GitHub does not return the content of ${where} (${body.size} bytes) through its API.`,
          "Read it in a sandbox (sandbox_start), or search for the part you need with github_search_code.",
        );
      }
      const all = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
      const cap = maxFileBytes();
      const cut = all.length > cap;
      const bytes = cut ? all.subarray(0, cap) : all;
      if (looksBinary(bytes, cut)) {
        throw new ToolError(
          "binary_file",
          `${where} is a binary file (${all.length} bytes), which this tool does not return.`,
          "Read text files only; work with binary files in a sandbox (sandbox_start).",
        );
      }
      return {
        kind: "file" as const,
        repository: t.fullName,
        path: body.path,
        size: all.length,
        text: bytes.toString("utf8"),
        truncated: cut,
        ...(cut
          ? {
              note: `Cut: this is the first ${cap} of ${all.length} bytes. The rest is not shown; read the whole file in a sandbox, or search it with github_search_code.`,
            }
          : {}),
        ...(body.html_url ? { url: body.html_url } : {}),
      };
    }),
};
