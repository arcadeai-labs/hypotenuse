import { z } from "zod";
import { linearCall } from "../ops/LinearOps";
import {
  isLinearConversation,
  linearScope,
  linearToolError,
} from "./linear-shared";
import type { ToolDefinition } from "./types";

const input = z.object({});

const output = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.string().nullable(),
  description: z.string(),
  comments: z.array(z.object({ author: z.string(), body: z.string() })),
});

/** The issue's fields this tool reads. */
const ISSUE_VIEW = `query IssueView($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { name type }
    comments { nodes { body user { name } } }
  }
}`;

/** The longest description shown. */
const DESCRIPTION_MAX = 8_000;

/**
 * `linear_issue_view` — read the issue this Linear session is about: its
 * title, state, description, and comments. Read-only, replay-safe, and only
 * in a Linear session; the issue comes from the conversation, never from the
 * model.
 */
export const linearIssueView: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "linear_issue_view",
  description:
    "Read the Linear issue this session is about: its identifier, title, state, description, and comments, as they are now in Linear. Takes no arguments: it is always this session's issue.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: (ctx) => isLinearConversation(ctx),
  run: async (_args, ctx) => {
    const scope = await linearScope(ctx);
    try {
      const { issue } = await linearCall<{
        issue: {
          identifier: string;
          title: string;
          description: string | null;
          url: string;
          state: { name: string } | null;
          comments: {
            nodes: { body: string; user: { name: string } | null }[];
          };
        };
      }>(scope.inst, ISSUE_VIEW, { id: scope.issueId });
      const description = issue.description ?? "";
      return {
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state?.name ?? null,
        description:
          description.length > DESCRIPTION_MAX
            ? `${description.slice(0, DESCRIPTION_MAX)}\n\n… (cut; the rest is at ${issue.url})`
            : description,
        comments: issue.comments.nodes.slice(-20).map((c) => ({
          author: c.user?.name ?? "someone",
          body: c.body.slice(0, 2_000),
        })),
      };
    } catch (e) {
      throw linearToolError(e, "show the issue");
    }
  },
};
