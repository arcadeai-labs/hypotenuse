import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { type AgentSessionRole, agentSessions } from "./agent_sessions";
import { projects } from "./projects";
import { runners } from "./runners";
import { users } from "./users";
import { type WorkItemKind, workItems } from "./work_items";

/** How a claim ended: as its turn did, or back in the queue for another claim. */
export const COST_RECORD_ENDINGS = [
  "completed",
  "failed",
  "cancelled",
  "requeued",
] as const;

/** One of {@link COST_RECORD_ENDINGS}. */
export type CostRecordEnding = (typeof COST_RECORD_ENDINGS)[number];

/**
 * A `cost_record` is one **claim** of a turn that ended: what the runner's
 * agent spent on it and everything it is attributable to, written in the
 * transaction that ended the claim (`CostOps.recordClaimCost`).
 *
 * - **Per claim, not per turn.** A turn whose lease lapsed ran twice, maybe
 *   on two people's runners, and gets two records. A turn never claimed
 *   spent nothing and gets none.
 * - **Attribution is copied.** The runner's name and owner, the issue, the
 *   role, and the manager a worker was dispatched by are what they were when
 *   the money was spent; the ids are kept as well (`set null`) for a live join.
 * - **Cost is what the agent reported**, in US dollars, for this claim only.
 *   Null when it reported none; Hypotenuse never prices tokens itself.
 */
export const costRecords = pgTable(
  "cost_records",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentSessionId: integer("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    /** The manager session a worker was dispatched by, else the session itself. */
    rootAgentSessionId: integer("root_agent_session_id").notNull(),
    workItemId: integer("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkItemKind>().notNull(),
    role: text("role").$type<AgentSessionRole | null>(),
    repository: text("repository"),
    /** The trigger system's issue id, and the identifier a person reads (`ENG-123`). */
    externalIssueId: text("external_issue_id"),
    issueIdentifier: text("issue_identifier"),
    runnerId: integer("runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    runnerName: text("runner_name").notNull(),
    /** The runner's owner: whose machine, and whose agent account, ran it. */
    runnerUserId: integer("runner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The Hypotenuse user who asked for the turn, when one was resolved. */
    issuerUserId: integer("issuer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    ending: text("ending").$type<CostRecordEnding>().notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    claimIndex: uniqueIndex("cost_records_claim_idx").on(
      t.workItemId,
      t.claimedAt,
    ),
    projectEndedIndex: index("cost_records_project_ended_idx").on(
      t.projectId,
      t.endedAt,
    ),
    sessionIndex: index("cost_records_session_idx").on(t.agentSessionId),
    rootIndex: index("cost_records_root_idx").on(t.rootAgentSessionId),
  }),
);

/** A `cost_records` row. */
export type CostRecord = typeof costRecords.$inferSelect;
