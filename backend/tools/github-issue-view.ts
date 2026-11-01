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
  number: z.number().int().positive().describe("The issue's number."),
});

const output = z.object({
  repository: z.string(),
  number: z.number(),
  title: z.string(),
  /** GitHub's `state`, renamed: transcripts drop every key named `state`. */
  status: z.string(),
  author: z.string().nullable(),
  body: z.string(),
  labels: z.array(z.string()),
  comments: z.number(),
  isPullRequest: z.boolean(),
  url: z.string(),
});

/** The longest body shown. */
const BODY_MAX = 8_000;

/** GitHub's issue, the fields read. */
interface IssueAnswer {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  labels: (string | { name?: string })[];
  comments?: number;
  pull_request?: unknown;
}

/**
 * `github_issue_view` — read one issue of a granted repository: title, status,
 * author, description, and labels. GitHub numbers pull requests and issues
 * together, so a pull request's number answers too, marked as one.
 */
export const githubIssueView: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "github_issue_view",
  description:
    "Read an issue in a GitHub repository granted to you: its title, status (open or closed), author, description, labels, comment count, and link. A pull request's number works too and is marked isPullRequest (use github_pr_view for its branches and merge state). Anything that needs a checkout, a build, or a change belongs in a sandbox (sandbox_start).",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: hasGitHubRepositories,
  run: async (args, ctx) =>
    withRepositoryToken(ctx, args.repository, "issues", async (token, t) => {
      const issue = await githubGet<IssueAnswer>(
        token,
        `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/issues/${args.number}`,
        `${t.fullName} has no issue #${args.number}.`,
        "Check the number and the repository.",
      );
      const body = issue.body ?? "";
      return {
        repository: t.fullName,
        number: issue.number,
        title: issue.title,
        status: issue.state,
        author: issue.user?.login ?? null,
        body:
          body.length > BODY_MAX
            ? `${body.slice(0, BODY_MAX)}\n\n… (cut; the rest is at ${issue.html_url})`
            : body,
        labels: issue.labels
          .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
          .filter(Boolean),
        comments: issue.comments ?? 0,
        isPullRequest: issue.pull_request !== undefined,
        url: issue.html_url,
      };
    }),
};
