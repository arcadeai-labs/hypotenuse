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
import type { EncryptedSecret } from "../ops/CryptoOps";
import { bots } from "./bots";
import { conversations } from "./conversations";
import { projects } from "./projects";

/**
 * Where a code run stands.
 *
 * | Status | Means | `continuation` |
 * |---|---|---|
 * | `running` | a worker is running the program (or died running it) | kept from the last interruption, if any |
 * | `interrupted` | a gated host call is waiting for people; approvals name this run | sealed and stored |
 * | `completed` | the program returned; `output` is the `run_code` result | cleared |
 * | `failed` | the program, a limit, or the continuation failed; `output` is the error | cleared |
 * | `interrupted_by_crash` | recovery found it `running` under a dead lease and reported it interrupted | cleared |
 */
export const CODE_RUN_STATUSES = [
  "running",
  "interrupted",
  "completed",
  "failed",
  "interrupted_by_crash",
] as const;

/** One of {@link CODE_RUN_STATUSES}. */
export type CodeRunStatus = (typeof CODE_RUN_STATUSES)[number];

/**
 * One settled host call, journaled as it settles: what was called and how it
 * went, never its payload. `name` is the `server/tool` of an MCP call or the
 * path of a memory call. `gate` says how an MCP call was let through.
 */
export interface HostCallRecord {
  fn: string;
  name?: string;
  ok: boolean;
  errorType?: string;
  gate?: "allowed" | "approved" | "denied";
  approvalId?: number;
  argBytes: number;
  outputBytes: number;
  ms: number;
}

/**
 * A `code_run` is one `run_code` call's program: its source, what it called,
 * and how it ended. It belongs to the call's intent (`entryId`), one row per
 * intent.
 *
 * `continuation` is the Run SDK's signed continuation token — which carries
 * the source and every settled host call's result — sealed with `CryptoOps`.
 * It is signed with the project's own key (`projects.codeContinuationKey`)
 * and bound to `hypotenuse-run-v1:<project>:<conversation>:<intent>:<run>`,
 * and it is never serialized, written to a transcript, or logged.
 *
 * `hostCalls` is the journal: one {@link HostCallRecord} per settled call,
 * appended as it settles, so a crash mid-run can be reported with what had
 * already happened. `output` is the `tool_result` the run settles with,
 * kept so recovery can write it if the worker died between the two.
 */
export const codeRuns = pgTable(
  "code_runs",
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
    entryId: integer("entry_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    source: text("source").notNull(),
    status: text("status").$type<CodeRunStatus>().notNull().default("running"),
    continuation: jsonb("continuation").$type<EncryptedSecret>(),
    interruptionIds: jsonb("interruption_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    hostCalls: jsonb("host_calls")
      .$type<HostCallRecord[]>()
      .notNull()
      .default([]),
    output: jsonb("output").$type<Record<string, unknown>>(),
    invocations: integer("invocations").notNull().default(0),
    bridgeRequests: integer("bridge_requests").notNull().default(0),
    durationMs: integer("duration_ms"),
    resultBytes: integer("result_bytes"),
    errorType: text("error_type"),
    leaseOwner: text("lease_owner"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("code_runs_entry_idx").on(t.entryId),
    index("code_runs_conversation_idx").on(t.conversationId, t.id),
  ],
);

export type CodeRun = typeof codeRuns.$inferSelect;
export type NewCodeRun = typeof codeRuns.$inferInsert;
