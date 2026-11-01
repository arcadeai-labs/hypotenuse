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
  number: z.number().int().positive().describe("The pull request's number."),
});

const output = z.object({
  repository: z.string(),
  number: z.number(),
  title: z.string(),
  /** GitHub's `state`, renamed: transcripts drop every key named `state`. */
  status: z.string(),
  merged: z.boolean(),
  draft: z.boolean(),
  headRef: z.string(),
  baseRef: z.string(),
  author: z.string().nullable(),
  body: z.string(),
  url: z.string(),
});

/** The longest body shown. */
const BODY_MAX = 8_000;

/** GitHub's pull request, the fields read. */
interface PullAnswer {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  draft?: boolean;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
}

/**
 * `github_pr_view` — read one pull request of a granted repository: title,
 * status, whether it merged, its branches, author, and description.
 */
export const githubPrView: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "github_pr_view",
  description:
    "Read a pull request in a GitHub repository granted to you: its title, status (open or closed), whether it was merged, its head and base branches, author, description, and link. Use it to answer questions about a pull request; reviewing its code in depth, building it, or changing it belongs in a sandbox (sandbox_start).",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasGitHubRepositories,
  run: async (args, ctx) =>
    withRepositoryToken(
      ctx,
      args.repository,
      "pull_requests",
      async (token, t) => {
        const pr = await githubGet<PullAnswer>(
          token,
          `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${args.number}`,
          `${t.fullName} has no pull request #${args.number}.`,
          "Check the number; it may be an issue (github_issue_view) rather than a pull request.",
        );
        const body = pr.body ?? "";
        return {
          repository: t.fullName,
          number: pr.number,
          title: pr.title,
          status: pr.state,
          merged: pr.merged === true,
          draft: pr.draft === true,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          author: pr.user?.login ?? null,
          body:
            body.length > BODY_MAX
              ? `${body.slice(0, BODY_MAX)}\n\n… (cut; the rest is at ${pr.html_url})`
              : body,
          url: pr.html_url,
        };
      },
    ),
};
