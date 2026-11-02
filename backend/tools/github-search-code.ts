import { z } from "zod";
import {
  githubGet,
  hasGitHubRepositories,
  REPOSITORY_DESCRIPTION,
  withRepositoryToken,
} from "./github-shared";
import type { ToolDefinition } from "./types";

const input = z.object({
  repository: z.string().min(1).describe(REPOSITORY_DESCRIPTION),
  query: z
    .string()
    .min(1)
    .describe(
      "What to search for: words or an identifier, with GitHub's code-search qualifiers if you like (`path:`, `language:`, `extension:`). The repository is added for you.",
    ),
});

const output = z.object({
  repository: z.string(),
  total: z.number(),
  items: z.array(z.object({ path: z.string(), url: z.string() })),
});

/** The most matches returned. */
const MAX_ITEMS = 50;

/** GitHub's code-search answer. */
interface SearchAnswer {
  total_count: number;
  items: { path: string; html_url: string }[];
}

/**
 * `github_search_code` — search one granted repository's default branch with
 * GitHub's code search, server-side and without a sandbox. The repository
 * qualifier is the tool's, never the model's: any `repo:`, `org:`, or
 * `user:` the model writes is dropped.
 */
export const githubSearchCode: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "github_search_code",
  description:
    "Search the code of a GitHub repository granted to you (its default branch) and get the paths of matching files, with links. Read a match with github_file_read. Use it to find where something lives; anything that needs a checkout, a build, running tests, or a change belongs in a sandbox (sandbox_start).",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasGitHubRepositories,
  run: async (args, ctx) =>
    withRepositoryToken(ctx, args.repository, "contents", async (token, t) => {
      const terms = args.query
        .replace(/(^|\s)(repo|org|user):\S+/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const q = `${terms} repo:${t.fullName}`;
      const body = await githubGet<SearchAnswer>(
        token,
        `/search/code?q=${encodeURIComponent(q)}&per_page=${MAX_ITEMS}`,
        `GitHub could not search ${t.fullName}.`,
        "Try again later, or read files directly with github_file_read.",
      );
      return {
        repository: t.fullName,
        total: body.total_count,
        items: body.items.slice(0, MAX_ITEMS).map((i) => ({
          path: i.path,
          url: i.html_url,
        })),
      };
    }),
};
