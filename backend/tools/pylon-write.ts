import { api } from "keryx";
import { z } from "zod";
import { approvalForIntent, outcomeOfApproval } from "../ops/ApprovalOps";
import { callKey } from "../ops/ApprovalPatternOps";
import { writeAuditLog } from "../ops/AuditOps";
import { markdownToPylonHtml } from "../ops/PylonMarkdownOps";
import {
  latestPublicMessageId,
  pylonMessages,
  pylonRequest,
} from "../ops/PylonOps";
import { rateReplyRisk } from "../ops/PylonRiskOps";
import {
  isPylonConversation,
  pylonScope,
  pylonToolError,
  replyPolicyOf,
} from "./pylon-shared";
import { type ToolDefinition, ToolError, toolErrorEnvelope } from "./types";

/**
 * The Pylon tools that change something: updating the issue, and the one way
 * a bot ever speaks to a customer.
 */

/** The approval server for every Pylon write. */
const SERVER = "pylon";

const updateInput = z
  .object({
    state: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "The new state: new, waiting_on_you, waiting_on_customer, on_hold, closed, or a custom status slug",
      ),
    tags: z
      .array(z.string().trim().min(1).max(100))
      .max(50)
      .optional()
      .describe("The issue's full tag list (replaces it)"),
    assigneeId: z
      .string()
      .max(200)
      .optional()
      .describe('A Pylon user id to assign, or "" to unassign'),
    customFields: z
      .array(
        z.object({
          slug: z.string().min(1).max(200),
          value: z.string().max(2000),
        }),
      )
      .max(20)
      .optional()
      .describe("Custom field values, by slug"),
  })
  .refine(
    (v) =>
      v.state !== undefined ||
      v.tags !== undefined ||
      v.assigneeId !== undefined ||
      v.customFields !== undefined,
    "Name at least one of state, tags, assigneeId, customFields.",
  );

const updateOutput = z.object({ id: z.string(), state: z.string().nullable() });

/**
 * `pylon_issue_update` — change the issue this conversation is about: its
 * state, tags, assignee, or custom fields. Every call waits for a person's
 * approval, and is not replayed after a crash.
 */
export const pylonIssueUpdate: ToolDefinition<
  z.infer<typeof updateInput>,
  z.infer<typeof updateOutput>
> = {
  name: "pylon_issue_update",
  description:
    "Update the Pylon issue you are working: its state (e.g. waiting_on_customer), its tags (the full list), its assignee, or custom fields. Each update waits for a person to approve it. Merging and marking spam are not offered: a person does those.",
  inputSchema: updateInput as unknown as z.ZodType<z.infer<typeof updateInput>>,
  outputSchema: updateOutput,
  replay: "unsafe",
  parallelSafe: false,
  available: (ctx) => isPylonConversation(ctx),
  gate: async (args, ctx) => {
    const key = callKey(SERVER, "issue_update", args);
    const existing = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (existing) return outcomeOfApproval(ctx.db, existing, key);
    return {
      kind: "park",
      draft: {
        callKey: key,
        server: SERVER,
        tool: "issue_update",
        args,
        reason: "pylon-write",
      },
    };
  },
  run: async (args, ctx) => {
    const approval = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (
      !approval ||
      approval.status !== "approved" ||
      !approval.executingAt ||
      approval.callKey !== callKey(SERVER, "issue_update", args)
    ) {
      throw new ToolError(
        "approval_required",
        "A Pylon issue update needs a person's approval, and this call has none.",
        "Call pylon_issue_update again; it will wait for an approval.",
      );
    }
    const scope = await pylonScope(ctx);
    try {
      const issue = await pylonRequest<{ id: string; state?: string }>(
        scope.inst,
        "PATCH",
        `/issues/${encodeURIComponent(scope.issueId)}`,
        {
          ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.assigneeId !== undefined
            ? { assignee_id: args.assigneeId }
            : {}),
          ...(args.customFields !== undefined
            ? { custom_fields: args.customFields }
            : {}),
        },
        { write: true },
      );
      return { id: issue.id ?? scope.issueId, state: issue.state ?? null };
    } catch (e) {
      throw pylonToolError(e, "update the issue");
    }
  },
};

const replyInput = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "The reply to the customer, as markdown: complete, polite, and exactly what they should read",
    ),
});

const replyOutput = z.object({
  messageId: z.string(),
  decidedBy: z
    .enum(["a person", "the policy"])
    .describe("Who let it go: a person's approval, or the low-risk policy"),
  note: z.string(),
});

/** The approval tool name of a customer reply. */
const REPLY_TOOL = "reply_to_customer";

/**
 * **`pylon_reply_to_customer` — the only way a bot speaks to a customer.**
 * Offered only when the bot's `customerReplyPolicy` is not `never`.
 *
 * | Policy | Approval for this call | Risk check | Then |
 * |---|---|---|---|
 * | `never` | — | — | not offered; a call anyway is refused |
 * | `approve` | none | — | parks: a draft reply and a note ask the team; the approval sends exactly the approved text |
 * | `auto-on-low-risk` | none | `low` | sends now; audited as the decision of the admin who set the policy |
 * | `auto-on-low-risk` | none | `high` (or no answer) | parks, as under `approve` |
 * | any | approved / denied / pending / interrupted | — | the approval gate's table (`ApprovalOps`) |
 *
 * A reply answers the issue's newest customer-visible message and carries
 * `custom_source.external_id` = the call's idempotency key, so a resend after
 * a lost answer returns the message Pylon already has. Not replayed after a
 * crash.
 */
export const pylonReplyToCustomer: ToolDefinition<
  z.infer<typeof replyInput>,
  z.infer<typeof replyOutput>
> = {
  name: "pylon_reply_to_customer",
  description:
    "Send a reply to the customer on this Pylon issue — the only text of yours a customer ever sees. Depending on your policy, it waits for a person on the team to approve it (who sees exactly this text, as a draft), or is sent at once when it is plainly informational and commits the company to nothing. Write your findings for the team in your final answer as usual; use this only for the words the customer should read.",
  inputSchema: replyInput,
  outputSchema: replyOutput,
  replay: "unsafe",
  parallelSafe: false,
  available: async (ctx) => (await replyPolicyOf(ctx)) !== "never",
  gate: async (args, ctx) => {
    const key = callKey(SERVER, REPLY_TOOL, args);
    const existing = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (existing) return outcomeOfApproval(ctx.db, existing, key);
    const policy = await replyPolicyOf(ctx);
    if (policy === "never") {
      return {
        kind: "refuse",
        output: toolErrorEnvelope(
          "not_allowed",
          "You may not reply to customers on this Pylon queue.",
          "Write the suggested reply in your note to the team instead.",
        ),
      };
    }
    if (policy === "auto-on-low-risk") {
      const rated = await rateReplyRisk(ctx.bot, args.text, ctx.signal);
      if (rated.risk === "low") return { kind: "run" };
    }
    return {
      kind: "park",
      draft: {
        callKey: key,
        server: SERVER,
        tool: REPLY_TOOL,
        args,
        reason: "pylon-customer-reply",
      },
    };
  },
  run: async (args, ctx) => {
    const scope = await pylonScope(ctx);
    const approval = await approvalForIntent(ctx.db, ctx.intentEntryId);
    const approved =
      approval !== undefined &&
      approval.status === "approved" &&
      approval.executingAt !== null &&
      approval.callKey === callKey(SERVER, REPLY_TOOL, args);
    if (!approved && scope.policy !== "auto-on-low-risk") {
      throw new ToolError(
        "approval_required",
        "A reply to a customer needs a person's approval, and this call has none.",
        "Call pylon_reply_to_customer again; it will wait for an approval.",
      );
    }
    let messageId: string;
    try {
      const messages = await pylonMessages(scope.inst, scope.issueId);
      const answering = latestPublicMessageId(messages);
      if (!answering) {
        throw new ToolError(
          "no_customer_message",
          "This issue has no customer-visible message to reply to.",
          "Tell the team in your note what you would have sent.",
        );
      }
      const sent = await pylonRequest<{ id: string }>(
        scope.inst,
        "POST",
        `/issues/${encodeURIComponent(scope.issueId)}/reply`,
        {
          body_html: markdownToPylonHtml(args.text),
          message_id: answering,
          custom_source: { external_id: ctx.idempotencyKey },
        },
        { write: true, reserved: true },
      );
      messageId = sent.id;
    } catch (e) {
      throw pylonToolError(e, "send the reply");
    }
    if (!approved) {
      const setBy = scope.inst.installation.config
        .customerReplyPolicySetByUserId as number | null | undefined;
      await writeAuditLog(api.db.db, {
        actorType: setBy ? "user" : "system",
        userId: setBy ?? null,
        projectId: ctx.conversation.projectId,
        action: "pylon:auto-reply",
        targetType: "pylon-issue",
        targetPath: `${ctx.bot.slug}: issue ${scope.issueId}`,
        metadata: {
          policy: "auto-on-low-risk",
          decidedBy: "the customer reply policy",
          policySetByUserId: setBy ?? null,
          botId: ctx.bot.id,
          conversationId: ctx.conversation.id,
          issueId: scope.issueId,
          messageId,
        },
        after: { text: args.text },
      });
    }
    return {
      messageId,
      decidedBy: approved ? ("a person" as const) : ("the policy" as const),
      note: approved
        ? "Sent, as approved."
        : "Sent without a person, under the low-risk policy. Say in your note to the team that you replied, and what you said.",
    };
  },
};
