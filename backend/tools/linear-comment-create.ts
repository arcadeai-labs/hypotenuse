import { z } from "zod";
import { approvalForIntent, outcomeOfApproval } from "../ops/ApprovalOps";
import { callKey } from "../ops/ApprovalPatternOps";
import { bodyForLinear } from "../ops/LinearMarkdownOps";
import { linearCall } from "../ops/LinearOps";
import {
  isLinearConversation,
  linearScope,
  linearToolError,
} from "./linear-shared";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  body: z
    .string()
    .trim()
    .min(1)
    .max(50_000)
    .describe("The comment, as markdown"),
  parentId: z
    .string()
    .max(100)
    .optional()
    .describe("Reply under this comment of the issue, instead of at the top"),
});

const output = z.object({ id: z.string(), url: z.string().nullable() });

/** The approval's server and tool for a Linear comment. */
const SERVER = "linear";
const TOOL = "comment_create";

/** Create a comment. */
const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

/**
 * `linear_comment_create` — comment on the issue this Linear session is
 * about, as the bot's own app. A write, so every call waits for a person's
 * approval (the same gate as an MCP tool outside its allowlist), and is not
 * replayed after a crash. The issue comes from the conversation; the body's
 * mentions of the bot are neutralized.
 */
export const linearCommentCreate: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "linear_comment_create",
  description:
    "Comment on this session's Linear issue (or reply under one of its comments, with parentId), as yourself. Your session's activities already show your work and answer; use a comment only for something the issue's followers need on the issue itself. Each comment waits for a person to approve it.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: (ctx) => isLinearConversation(ctx),
  gate: async (args, ctx) => {
    const key = callKey(SERVER, TOOL, args);
    const existing = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (existing) return outcomeOfApproval(ctx.db, existing, key);
    return {
      kind: "park",
      draft: {
        callKey: key,
        server: SERVER,
        tool: TOOL,
        args,
        reason: "linear-write",
      },
    };
  },
  run: async (args, ctx) => {
    const approval = await approvalForIntent(ctx.db, ctx.intentEntryId);
    // Defense in depth: the tick runs this only after the gate said so.
    if (
      !approval ||
      approval.status !== "approved" ||
      !approval.executingAt ||
      approval.callKey !== callKey(SERVER, TOOL, args)
    ) {
      throw new ToolError(
        "approval_required",
        "A Linear comment needs a person's approval, and this call has none.",
        "Call linear_comment_create again; it will wait for an approval.",
      );
    }
    const scope = await linearScope(ctx);
    try {
      const { commentCreate } = await linearCall<{
        commentCreate: { comment: { id: string; url?: string | null } };
      }>(scope.inst, COMMENT_CREATE, {
        input: {
          issueId: scope.issueId,
          body: bodyForLinear(args.body, scope.names, ""),
          ...(args.parentId ? { parentId: args.parentId } : {}),
        },
      });
      return {
        id: commentCreate.comment.id,
        url: commentCreate.comment.url ?? null,
      };
    } catch (e) {
      throw linearToolError(e, "create the comment");
    }
  },
};
