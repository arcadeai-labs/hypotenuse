import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import {
  type Approval,
  type ApprovalDecidedVia,
  approvals,
  type NewApproval,
} from "../schema/approvals";
import type { Bot } from "../schema/bots";
import { codeRuns } from "../schema/code_runs";
import { conversationEntries } from "../schema/conversation_entries";
import type { Conversation } from "../schema/conversations";
import type { Tag } from "../schema/tags";
import { users } from "../schema/users";
import { type ToolErrorEnvelope, toolErrorEnvelope } from "../tools/types";
import { satisfiesAccess } from "./AccessOps";
import { canWriteBot } from "./BotOps";
import { enqueueTick, lockConversation, wake } from "./ConversationOps";
import type { DbHandle, TxHandle } from "./DbOps";
import { enqueueNotification, resolveRecipients } from "./NotificationOps";
import { scrubToolOutput } from "./TranscriptOps";

/**
 * **The approval gate**: every call a bot makes to an external tool is decided
 * before anything is sent.
 *
 * | Allowlisted by pattern | `readOnlyHint` and `autoAllowReadOnly` | Approval for this intent | Result |
 * |---|---|---|---|
 * | yes | — | — | run |
 * | no | yes | — | run |
 * | no | no | `approved`, not yet executing | run, and consume it with the result |
 * | no | no | `approved`, executing (a worker died mid-call) | interrupted; consumed |
 * | no | no | `denied` or `expired` | error result "denied by <who>; do not retry" |
 * | no | no | `pending` | still waiting: the conversation parks again |
 * | no | no | none | write an `approvals` row (`pending`); the conversation parks |
 *
 * The first two columns are `ApprovalPatternOps.allowance`. An approval names
 * one `tool_call_intent` (its entry id) and one `callKey`; a call whose key
 * differs from its approval's is refused, so an approval can never run a
 * different call.
 */

/** What the gate decided for one call. */
export type GateOutcome =
  /** Allowed without a person: run it. */
  | { kind: "run" }
  /** A person approved it: mark it executing, run it, consume it with the result. */
  | { kind: "run-approved"; approvalId: number }
  /** Write this error as the call's result. */
  | { kind: "refuse"; output: ToolErrorEnvelope; approvalId?: number }
  /** An approved call was cut off mid-run: report it interrupted. */
  | { kind: "interrupted"; approvalId: number }
  /** Wait for a person: an existing pending approval, or a new one to write. */
  | { kind: "park"; approvalId: number }
  | { kind: "park"; draft: ApprovalDraft };

/** A new approval, before the tick writes it. */
export type ApprovalDraft = Pick<
  NewApproval,
  "callKey" | "server" | "tool" | "args" | "reason"
> &
  Partial<Pick<NewApproval, "codeRunId" | "interruptionId">>;

/**
 * The approval written for a direct call's intent, if any. A code-mode
 * program's approvals name the `run_code` intent too, and are found by
 * {@link approvalForInterruption} instead.
 * @param db - A database handle.
 * @param entryId - The intent's entry id.
 * @returns The row, or `undefined`.
 */
export async function approvalForIntent(
  db: DbHandle,
  entryId: number,
): Promise<Approval | undefined> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.entryId, entryId), isNull(approvals.interruptionId)),
    )
    .limit(1);
  return row;
}

/**
 * The approval written for one interruption of a code-mode program, if any:
 * the resumed program consumes its own grant and never another's.
 * @param db - A database handle.
 * @param codeRunId - The program's run.
 * @param interruptionId - Run's id for the interrupted call.
 * @returns The row, or `undefined`.
 */
export async function approvalForInterruption(
  db: DbHandle,
  codeRunId: number,
  interruptionId: string,
): Promise<Approval | undefined> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.codeRunId, codeRunId),
        eq(approvals.interruptionId, interruptionId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The name of whoever decided an approval, for the sentence the model reads.
 * @param db - A database handle.
 * @param approval - The approval.
 * @returns A name, or "nobody in time" for an expiry.
 */
async function deciderName(db: DbHandle, approval: Approval): Promise<string> {
  if (approval.status === "expired") return "nobody in time (it expired)";
  if (!approval.decidedByUserId) return "a person";
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, approval.decidedByUserId));
  return u?.name ?? "a person";
}

/**
 * What an existing approval means for its call.
 * @param db - A database handle.
 * @param approval - The approval for this intent.
 * @param key - The call key of the intent's input.
 * @returns The outcome.
 */
export async function outcomeOfApproval(
  db: DbHandle,
  approval: Approval,
  key: string,
): Promise<GateOutcome> {
  if (approval.callKey !== key) {
    return {
      kind: "refuse",
      approvalId: approval.id,
      output: toolErrorEnvelope(
        "approval_mismatch",
        "The approval on record is for a different call than this one, so it was not run.",
        "Make the call again; it will wait for a new approval.",
      ),
    };
  }
  switch (approval.status) {
    case "pending":
      return { kind: "park", approvalId: approval.id };
    case "approved":
      return approval.executingAt
        ? { kind: "interrupted", approvalId: approval.id }
        : { kind: "run-approved", approvalId: approval.id };
    case "consumed":
      return { kind: "interrupted", approvalId: approval.id };
    default: {
      const who = await deciderName(db, approval);
      return {
        kind: "refuse",
        approvalId: approval.id,
        output: toolErrorEnvelope(
          "denied",
          `${approval.server}/${approval.tool} was denied by ${who}${approval.note ? `: "${approval.note}"` : ""}.`,
          "Do not retry this call. Try another approach, or ask the person what they want instead.",
        ),
      };
    }
  }
}

/**
 * Write the approvals a step's gated calls need, and queue the notifications
 * to whoever may decide. Runs in the tick's parking transaction.
 * @param tx - The holder's transaction.
 * @param conversation - The conversation, locked.
 * @param bot - Its bot.
 * @param drafts - One per gated call, with the intent it binds to.
 * @returns The new approvals' ids.
 */
export async function insertApprovals(
  tx: TxHandle,
  conversation: Conversation,
  bot: Bot,
  drafts: {
    draft: ApprovalDraft;
    intent: { id: number; stepId: string | null; toolCallId: string | null };
  }[],
): Promise<number[]> {
  if (drafts.length === 0) return [];
  const [asker] = await tx
    .select({ userId: conversationEntries.userId })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversation.id),
        eq(conversationEntries.kind, "message"),
        eq(conversationEntries.role, "user"),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  const expiresAt = new Date(Date.now() + bot.approvalTtlSeconds * 1000);
  const rows = await tx
    .insert(approvals)
    .values(
      drafts.map(({ draft, intent }) => ({
        ...draft,
        args: scrubToolOutput(draft.args) as Record<string, unknown>,
        projectId: conversation.projectId,
        botId: bot.id,
        conversationId: conversation.id,
        entryId: intent.id,
        stepId: intent.stepId,
        toolCallId: intent.toolCallId,
        requestedByUserId: asker?.userId ?? null,
        expiresAt,
      })),
    )
    .onConflictDoNothing()
    .returning();
  const recipients = await resolveRecipients(
    conversation.projectId,
    bot.approverTag,
  );
  for (const row of rows) {
    await enqueueNotification(tx, {
      projectId: conversation.projectId,
      userIds: recipients,
      template: "approval-requested",
      payload: {
        approvalId: row.id,
        botName: bot.displayName,
        server: row.server,
        tool: row.tool,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
      },
      linkPath: `/approvals/${row.id}`,
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Mark an approved call as executing, committed before it is sent: the
 * intent before the effect. Fails (returns `false`) if it is no longer
 * approved and idle — another worker took it.
 * @param tx - A transaction.
 * @param approvalId - The approval.
 * @returns `true` when this caller may send the call.
 */
export async function markExecuting(
  tx: TxHandle,
  approvalId: number,
): Promise<boolean> {
  const rows = await tx
    .update(approvals)
    .set({ executingAt: new Date() })
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.status, "approved"),
        sql`${approvals.executingAt} is null`,
      ),
    )
    .returning({ id: approvals.id });
  return rows.length === 1;
}

/**
 * Consume an approval, in the transaction that writes its call's result.
 * @param tx - The holder's transaction.
 * @param approvalId - The approval.
 */
export async function consumeApproval(
  tx: TxHandle,
  approvalId: number,
): Promise<void> {
  await tx
    .update(approvals)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(
      and(
        eq(approvals.id, approvalId),
        inArray(approvals.status, ["approved", "consumed"]),
      ),
    );
}

/**
 * Whether a person may decide a bot's approvals: they may write the bot, or
 * hold its approver tag.
 * @param bot - The bot.
 * @param callerTags - The caller's tags in the project.
 * @returns `true` if so.
 */
export function canDecide(bot: Bot, callerTags: Tag[]): boolean {
  if (canWriteBot(bot, callerTags)) return true;
  return bot.approverTag
    ? satisfiesAccess([bot.approverTag], callerTags)
    : false;
}

/** What a decision did. */
export interface DecideResult {
  before: Approval;
  approval: Approval;
  /** The conversation woke and owes a tick. */
  woke: Conversation | null;
}

/**
 * **Decide** an approval: lock its conversation (the one lock order), then
 * the approval, re-check that it is still pending, record the decision, and
 * wake the conversation when every approval it waits on is decided.
 * @param tx - An open transaction.
 * @param approvalId - The approval.
 * @param decision - What was decided, by whom, and where.
 * @returns What changed; enqueue a tick for `woke` after commit.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`, or
 *   `CONNECTION_ACTION_PARAM_VALIDATION` for one already decided or expired.
 */
export async function decideApproval(
  tx: TxHandle,
  approvalId: number,
  decision: {
    approve: boolean;
    userId: number | null;
    participantId?: number | null;
    via: ApprovalDecidedVia;
    note?: string | null;
  },
): Promise<DecideResult> {
  const [ref] = await tx
    .select({ conversationId: approvals.conversationId })
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!ref) throw approvalNotFound();
  const locked = await lockConversation(tx, ref.conversationId);
  const [before] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .for("update");
  if (!before || !locked) throw approvalNotFound();
  if (before.status !== "pending") {
    throw new TypedError({
      message: `This approval was already ${before.status === "consumed" ? "approved and run" : before.status}.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "decision",
    });
  }
  if (before.expiresAt.getTime() <= Date.now()) {
    await expireRows(tx, [before.id]);
    await wakeIfDecided(tx, locked.conversation);
    throw new TypedError({
      message: "This approval expired before it was decided.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "decision",
    });
  }
  const [approval] = await tx
    .update(approvals)
    .set({
      status: decision.approve ? "approved" : "denied",
      decidedByUserId: decision.userId,
      decidedByParticipantId: decision.participantId ?? null,
      decidedVia: decision.via,
      note: decision.note ?? null,
      decidedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId))
    .returning();
  const woke = await wakeIfDecided(tx, locked.conversation);
  return { before, approval, woke };
}

/**
 * Wake a conversation waiting on approvals once none of them is pending.
 * @param tx - The transaction holding the conversation's lock.
 * @param conversation - The conversation, locked.
 * @returns The woken conversation, or `null`.
 */
async function wakeIfDecided(
  tx: TxHandle,
  conversation: Conversation,
): Promise<Conversation | null> {
  const waitingOn = conversation.waitingOn;
  if (conversation.state !== "waiting" || waitingOn?.kind !== "approval")
    return null;
  const [still] = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        inArray(approvals.id, waitingOn.approvalIds),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (still) return null;
  return wake(tx, conversation, "approval");
}

/**
 * Mark approvals expired.
 * @param tx - A transaction.
 * @param ids - The approvals.
 */
async function expireRows(tx: TxHandle, ids: number[]): Promise<void> {
  await tx
    .update(approvals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(inArray(approvals.id, ids), eq(approvals.status, "pending")));
}

/**
 * **Expire** every pending approval past its time, conversation by
 * conversation, waking each one whose wait is over. An expired approval reads
 * as denied. The clock's work; unaudited, since nobody decided.
 * @param limit - The most approvals to look at in one run.
 * @returns How many expired.
 */
export async function expireDueApprovals(limit = 200): Promise<number> {
  const due = await api.db.db
    .select({ id: approvals.id, conversationId: approvals.conversationId })
    .from(approvals)
    .where(
      and(eq(approvals.status, "pending"), lt(approvals.expiresAt, sql`now()`)),
    )
    .limit(limit);
  const byConversation = new Map<number, number[]>();
  for (const row of due) {
    byConversation.set(row.conversationId, [
      ...(byConversation.get(row.conversationId) ?? []),
      row.id,
    ]);
  }
  let expired = 0;
  for (const [conversationId, ids] of byConversation) {
    const woke = await api.db.db.transaction(async (tx) => {
      const locked = await lockConversation(tx, conversationId);
      if (!locked) return null;
      const rows = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            inArray(approvals.id, ids),
            eq(approvals.status, "pending"),
            lt(approvals.expiresAt, sql`now()`),
          ),
        )
        .for("update");
      if (rows.length === 0) return null;
      await expireRows(
        tx,
        rows.map((r) => r.id),
      );
      expired += rows.length;
      return wakeIfDecided(tx, locked.conversation);
    });
    if (woke) await enqueueTick(woke);
  }
  return expired;
}

/**
 * The 404 every unreadable or missing approval answers with.
 * @returns The error.
 */
export function approvalNotFound(): TypedError {
  return new TypedError({
    message: "Approval not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Shape an approval for any answer. `args` is stored scrubbed.
 * @param row - The approval.
 * @returns The serialized approval.
 */
export function serializeApproval(row: Approval) {
  return {
    id: row.id,
    projectId: row.projectId,
    botId: row.botId,
    conversationId: row.conversationId,
    entryId: row.entryId,
    callKey: row.callKey,
    server: row.server,
    tool: row.tool,
    name: `${row.server}/${row.tool}`,
    args: row.args,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    requestedByParticipantId: row.requestedByParticipantId,
    decidedByUserId: row.decidedByUserId,
    decidedByParticipantId: row.decidedByParticipantId,
    decidedVia: row.decidedVia,
    note: row.note,
    expiresAt: row.expiresAt.getTime(),
    decidedAt: row.decidedAt?.getTime() ?? null,
    executingAt: row.executingAt?.getTime() ?? null,
    consumedAt: row.consumedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Whether a conversation's `mcp_info` for a tool was read: a result of it,
 * not an error, names the tool, or a code-mode program's journal records an
 * `mcp.info` of it that answered. Compaction keeps the rows, so a read before
 * a compaction still counts.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @param name - `server/tool`.
 * @returns `true` if read.
 */
export async function infoWasRead(
  db: DbHandle,
  conversationId: number,
  name: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationEntries.id })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        eq(conversationEntries.kind, "tool_result"),
        eq(conversationEntries.toolName, "mcp_info"),
        isNotNull(conversationEntries.content),
        sql`${conversationEntries.content}->'output'->>'name' = ${name}`,
      ),
    )
    .limit(1);
  if (row) return true;
  const [fromCode] = await db
    .select({ id: codeRuns.id })
    .from(codeRuns)
    .where(
      and(
        eq(codeRuns.conversationId, conversationId),
        sql`${codeRuns.hostCalls} @> ${JSON.stringify([{ fn: "mcp.info", name, ok: true }])}::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(fromCode);
}
