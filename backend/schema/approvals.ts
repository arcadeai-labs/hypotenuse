import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { conversations } from "./conversations";
import { projects } from "./projects";
import { users } from "./users";

/**
 * Where an approval stands.
 *
 * | Status | Means |
 * |---|---|
 * | `pending` | waiting for a person |
 * | `approved` | a person approved it; the call has not finished |
 * | `denied` | a person refused it; the model is told not to retry |
 * | `expired` | nobody decided in time; read as denied |
 * | `consumed` | the approved call ran, and its result was written with this status |
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
] as const;

/** One of {@link APPROVAL_STATUSES}. */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Where a person decided: a dashboard, a client, or a platform's channel. */
export const APPROVAL_DECIDED_VIA = [
  "dashboard",
  "webhook",
  "api",
  "cli",
  "mcp",
  "slack",
  "linear",
  "pylon",
] as const;

/** One of {@link APPROVAL_DECIDED_VIA}. */
export type ApprovalDecidedVia = (typeof APPROVAL_DECIDED_VIA)[number];

/**
 * An `approval` is one tool call a bot wants to make and a person must allow
 * first. It is bound to exactly one call: the `tool_call_intent` entry
 * (`entryId`, with its `stepId` and `toolCallId`) and the `callKey`, a digest
 * of the server, tool, and arguments. A decision can never run a different
 * call.
 *
 * `executingAt` is the intent before the effect: it is committed before the
 * approved call is sent, so a worker that dies mid-call leaves a row that says
 * the call may have run, and recovery reports it interrupted rather than
 * sending it twice. `consumedAt` is written in the transaction that writes the
 * call's result.
 *
 * `args` is stored scrubbed of `SENSITIVE_KEYS`, for the person deciding;
 * the call itself runs with the intent's own input.
 *
 * A gated call inside a code-mode program carries `codeRunId` and the Run
 * SDK's `interruptionId` as well; its `entryId` is the `run_code` intent,
 * which may wait on several approvals at once, so uniqueness is per intent for
 * a direct call and per `(codeRunId, interruptionId)` for a program's call.
 * The resumed program consumes its own approval and never another's.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    entryId: integer("entry_id"),
    stepId: text("step_id"),
    toolCallId: text("tool_call_id"),
    codeRunId: integer("code_run_id"),
    interruptionId: text("interruption_id"),
    callKey: text("call_key").notNull(),
    server: text("server").notNull(),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull().default("not-allowlisted"),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    requestedByUserId: integer("requested_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    requestedByParticipantId: integer("requested_by_participant_id"),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedByParticipantId: integer("decided_by_participant_id"),
    decidedVia: text("decided_via").$type<ApprovalDecidedVia>(),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executingAt: timestamp("executing_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("approvals_entry_idx")
      .on(t.entryId)
      .where(sql`${t.interruptionId} is null`),
    uniqueIndex("approvals_interruption_idx").on(t.codeRunId, t.interruptionId),
    index("approvals_project_status_idx").on(t.projectId, t.status, t.id),
    index("approvals_conversation_idx").on(t.conversationId),
    index("approvals_pending_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
