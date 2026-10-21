import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { type AgentSessionRole, agentSessions } from "./agent_sessions";
import { projects } from "./projects";
import { runners } from "./runners";

/** What a turn is for. */
export const WORK_ITEM_KINDS = [
  "session_created",
  "prompt",
  "dispatch",
  "review",
] as const;

/** One of {@link WORK_ITEM_KINDS}. */
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/** Every state a work item can be in. */
export const WORK_ITEM_STATUSES = [
  "queued",
  "offered",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

/** One of {@link WORK_ITEM_STATUSES}. */
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** The statuses of the one turn a session may have under way. */
export const ACTIVE_WORK_STATUSES = ["offered", "claimed", "running"] as const;

/** The statuses a runner holds a claim in. */
export const HELD_WORK_STATUSES = ["claimed", "running"] as const;

/** The statuses nothing comes back from. */
export const TERMINAL_WORK_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

/** Why a turn was cancelled. */
export const WORK_CANCEL_REASONS = [
  "stop",
  "delegate_removed",
  "integration_revoked",
  "dashboard",
  "superseded",
] as const;

/** One of {@link WORK_CANCEL_REASONS}. */
export type WorkCancelReason = (typeof WORK_CANCEL_REASONS)[number];

/** One merged follow-up, in the order it was typed. */
export interface WorkItemPrompt {
  activityId: number;
  body: string;
}

/** What `daemon:complete` reported. */
export interface WorkItemOutcome {
  outcome: "completed" | "failed" | "cancelled";
  error?: string | null;
  acpSessionId?: string | null;
  branch?: string | null;
}

/** The last `usage` event a daemon reported for the turn. */
export interface WorkItemUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contextUsed?: number;
  contextSize?: number;
}

/**
 * A `work_item` is one **turn** of an agent session: the session's creation, a
 * follow-up prompt (possibly several merged), a manager's dispatch, or a
 * review. It is what routing places on a runner.
 *
 * - **Prepared, then placed.** `role` is null until routing has read the issue
 *   and chosen one; `repositoryResolved` is false until the repository is
 *   chosen (by a rule's pin, by the runners' checkouts, by Linear's
 *   suggestions, or by a person answering a `select`). Only a prepared item is
 *   offered.
 * - **An offer, then a claim.** `offeredToRunnerId` / `offerExpiresAt` are the
 *   current offer; `runnerId` / `leaseExpiresAt` the current claim, renewed by
 *   the runner's heartbeats and events. A lapsed offer is remembered in
 *   `lapsedOffers` so the next one goes elsewhere.
 * - **One active turn per session**: a partial unique index over
 *   `agentSessionId` for `offered`, `claimed`, and `running`. Queued items wait
 *   their turn in `id` order — which is what makes a follow-up see the previous
 *   turn's result, and keeps two runners out of one worktree.
 * - **A turn ends in one place**, `WorkItemOps.finishWorkItem`, which also
 *   guarantees the session is answered: `answeredAt` records the first
 *   `response`, `error`, or `elicitation` the turn produced.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentSessionId: integer("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkItemKind>().notNull(),
    /** Copied from the session once routing has chosen it; fixed for the session's life. */
    role: text("role").$type<AgentSessionRole | null>(),
    status: text("status").$type<WorkItemStatus>().notNull().default("queued"),
    /** `hostname/owner/name`, or null (a manager may work without one). */
    repository: text("repository"),
    /** Whether `repository` has been decided, null included. */
    repositoryResolved: boolean("repository_resolved").notNull().default(false),
    /** For `prompt`: the merged follow-ups in order. */
    prompt: jsonb("prompt").$type<WorkItemPrompt[] | null>(),
    /** The issuer's Hypotenuse user, when one was resolved. */
    preferredUserId: integer("preferred_user_id"),
    /** The runner holding the session's worktree when this item was created. */
    stickyRunnerId: integer("sticky_runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    offeredToRunnerId: integer("offered_to_runner_id").references(
      () => runners.id,
      { onDelete: "set null" },
    ),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
    /** Runner id → when its offer lapsed, epoch ms; skipped for `offerTtl × 3`. */
    lapsedOffers: jsonb("lapsed_offers")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    runnerId: integer("runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** The runner's agent for this role, recorded at offer; counted against `limits.agents`. */
    agentId: text("agent_id"),
    /** Whether the claiming runner starts a new worktree; decided at claim. */
    fresh: boolean("fresh"),
    /** When this item last became `queued`; the queue and sticky timeouts count from it. */
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Why it cannot be placed yet, as last told to the session. */
    waitingReason: text("waiting_reason"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelReason: text("cancel_reason").$type<WorkCancelReason | null>(),
    /** Claims that ended without completion (lapsed leases). */
    attempts: integer("attempts").notNull().default(0),
    /** The highest event `seq` accepted. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    /** The first response, error, or elicitation of the turn. */
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** The daemon's last `status` event state. */
    daemonState: text("daemon_state"),
    usage: jsonb("usage").$type<WorkItemUsage | null>(),
    outcome: jsonb("outcome").$type<WorkItemOutcome | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    oneActivePerSession: uniqueIndex("work_items_one_active_idx")
      .on(t.agentSessionId)
      .where(sql`${t.status} IN ('offered', 'claimed', 'running')`),
    // Routing walks queued items in id order; the reaper finds lapsed leases.
    statusIndex: index("work_items_status_idx").on(t.status, t.id),
    sessionIndex: index("work_items_session_idx").on(t.agentSessionId, t.id),
    // Capacity is counted per runner over live items.
    offeredRunnerIndex: index("work_items_offered_runner_idx")
      .on(t.offeredToRunnerId)
      .where(sql`${t.status} = 'offered'`),
    heldRunnerIndex: index("work_items_held_runner_idx")
      .on(t.runnerId)
      .where(sql`${t.status} IN ('claimed', 'running')`),
  }),
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;
