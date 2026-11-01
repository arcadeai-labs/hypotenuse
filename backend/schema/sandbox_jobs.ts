import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { conversations } from "./conversations";
import { projects } from "./projects";

/** Every status a sandbox job can be in. */
export const SANDBOX_JOB_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
] as const;

/** One of {@link SANDBOX_JOB_STATUSES}. */
export type SandboxJobStatus = (typeof SANDBOX_JOB_STATUSES)[number];

/** The statuses a job's token is honoured in: it is alive. */
export const ACTIVE_SANDBOX_JOB_STATUSES: SandboxJobStatus[] = [
  "provisioning",
  "running",
  "awaiting_input",
];

/** The statuses a job ends in. `finalizeSandboxJob` is the only writer. */
export const TERMINAL_SANDBOX_JOB_STATUSES: SandboxJobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
];

/** What a job's artifacts look like: one text per name. */
export type SandboxArtifacts = Record<
  string,
  { content: string; updatedAt: number }
>;

/** Model traffic the proxy forwarded for a job. */
export interface SandboxJobUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/**
 * A `sandbox_job` is one piece of code work a bot handed to a coding agent in
 * an ephemeral sandbox. It belongs to the conversation that started it
 * (`parentConversationId`) and carries that bot's authority, never more.
 *
 * - `status` moves `pending` → `provisioning` → `running` (→ `awaiting_input`
 *   between an interactive job's turns) → a terminal status, stamped once by
 *   `finalizeSandboxJob` (first reason wins), which also wakes the parent.
 * - `tokenHash` is the SHA-256 of the job token, the only credential the
 *   sandbox holds; the plaintext lives in Redis under Keryx's OAuth key.
 * - `lastHeartbeatAt` (the supervisor is alive) and `lastActivityAt` (the
 *   agent is doing something: an event, a status, an ask) are the reaper's
 *   two clocks; `endReason` says which sweep, or which path, ended it.
 * - `briefing` is the exact text written to the sandbox's prompt file, so
 *   what the agent saw is inspectable.
 * - `repository` is read by git and pull requests, which do not exist yet.
 * - `usage` is what the model proxy measured — `{ inputTokens,
 *   outputTokens, requests }`, summed over every request it forwarded — and
 *   `cliUsage` the coding CLI's own report at completion. `budgetTokens`
 *   caps `usage`'s input plus output tokens: over it, the proxy answers 402
 *   and the job is cancelled. `costUsd` is reserved for priced spend, which
 *   needs a price table this deployment does not have yet.
 */
export const sandboxJobs = pgTable(
  "sandbox_jobs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    botId: integer("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    parentConversationId: integer("parent_conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    intentEntryId: integer("intent_entry_id"),
    triggeredByParticipantId: integer("triggered_by_participant_id"),
    triggeredByUserId: integer("triggered_by_user_id"),
    title: text("title").notNull(),
    task: text("task").notNull(),
    briefing: text("briefing"),
    repository: jsonb("repository").$type<Record<string, unknown>>(),
    interactive: boolean("interactive").notNull().default(false),
    status: text("status").$type<SandboxJobStatus>().notNull(),
    provider: text("provider"),
    reportedStatus: text("reported_status"),
    statusMessage: text("status_message"),
    closingText: text("closing_text"),
    artifacts: jsonb("artifacts")
      .$type<SandboxArtifacts>()
      .notNull()
      .default({}),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    tokenHash: text("token_hash"),
    cliSessionId: text("cli_session_id"),
    exitCode: integer("exit_code"),
    endReason: text("end_reason"),
    error: text("error"),
    usage: jsonb("usage")
      .$type<SandboxJobUsage>()
      .notNull()
      .default({ inputTokens: 0, outputTokens: 0, requests: 0 }),
    cliUsage: jsonb("cli_usage").$type<Record<string, unknown>>(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    budgetTokens: integer("budget_tokens"),
    maxDurationMs: integer("max_duration_ms").notNull(),
    idleTimeoutMs: integer("idle_timeout_ms").notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    awaitingInputSince: timestamp("awaiting_input_since", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("sandbox_jobs_status_project_idx").on(
      t.status,
      t.projectId,
      t.createdAt,
    ),
    index("sandbox_jobs_parent_idx").on(t.parentConversationId),
    index("sandbox_jobs_project_created_idx").on(t.projectId, t.id),
    index("sandbox_jobs_token_idx")
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
  ],
);

export type SandboxJob = typeof sandboxJobs.$inferSelect;
export type NewSandboxJob = typeof sandboxJobs.$inferInsert;
