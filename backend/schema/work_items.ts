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
import { users } from "./users";

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
  "issue_closed",
  "integration_revoked",
  "dashboard",
  "superseded",
] as const;

/** One of {@link WORK_CANCEL_REASONS}. */
export type WorkCancelReason = (typeof WORK_CANCEL_REASONS)[number];

/**
 * Why a turn waits, as a machine code — the same codes
 * `routing-rule:preview` gives each runner it rules out
 * (`RUNNER_REASON_CODES` in `ops/RoutingOps.ts`), plus the waits that are
 * about the turn rather than a runner.
 */
export const WAITING_CODES = [
  "offline",
  "draining",
  "paused",
  "no_capacity",
  "role_not_served",
  "repository_missing",
  "subscription_mismatch",
  "no_runners",
  "sticky_runner",
  "offer_lapsed",
] as const;
/** One of {@link WAITING_CODES}. */
export type WaitingCode = (typeof WAITING_CODES)[number];
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

/** One issue hygiene rule's outcome, as recorded at claim. */
export interface HygieneOutcome {
  /** `moved`, `set`, `unchanged`, `skipped`, or `failed`. */
  outcome: "moved" | "set" | "unchanged" | "skipped" | "failed";
  /** Why, or what it was moved to. */
  detail: string;
}

/** What issue hygiene did when the turn was claimed. */
export interface WorkItemHygiene {
  /** The started-state move. */
  state: HygieneOutcome;
  /** The delegate. */
  delegate: HygieneOutcome;
  at: number;
}

/** The last `usage` event a daemon reported for the turn. */
export interface WorkItemUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contextUsed?: number;
  contextSize?: number;
}

/** One write an agent tool made in Linear during the turn. */
export interface LinearWrite {
  /** The MCP tool that wrote it (`linear_create_issue`, …). */
  tool: string;
  /** What it wrote to, as a person reads it: `ENG-124`, a project or document name. */
  target: string;
  /** The Linear id of what was written or created. */
  linearId: string;
  /** Epoch ms. */
  at: number;
}

/** What a `dispatch` turn, or a `changes` `prompt` turn, carries for the worker. */
export interface WorkItemDispatchPayload {
  mode: "new" | "changes";
  reviewRound: number;
  instructions: string | null;
  agentPreference: string | null;
  /** The manager session that dispatched it. */
  dispatchedBy: number;
}

/** What a `review` turn carries for the manager: one worker's result. */
export interface WorkItemReviewPayload {
  childSessionId: number;
  childIssueIdentifier: string | null;
  childIssueUrl: string | null;
  reviewRound: number;
  outcome: "completed" | "failed" | "cancelled";
  finalResponse: string | null;
  plan: { content: string; status: string }[] | null;
  pullRequests: { label: string; url: string }[];
}

/** A turn's payload: what a manager handed a worker, or a worker's result for review. */
export type WorkItemPayload =
  | { dispatch: WorkItemDispatchPayload }
  | { review: WorkItemReviewPayload };

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
 * - **A question mid-turn is answered in the turn.** An `elicitation` from a
 *   held turn sets `awaitingAnswerSince`; the person's next follow-up is
 *   appended to `answers` (and heartbeats deliver it) instead of queueing a
 *   turn. Whatever the daemon does not report consuming becomes the next
 *   `prompt` turn when this one ends.
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
    /**
     * What a manager handed a worker (`dispatch`, or a `prompt` requesting
     * changes) or a worker's result (`review`). Linear lets no agent write a
     * prompt, so a review's input exists only here.
     */
    payload: jsonb("payload").$type<WorkItemPayload | null>(),
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
    /** {@link waitingReason} as a code; null when it is not waiting. */
    waitingCode: text("waiting_code").$type<WaitingCode | null>(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelReason: text("cancel_reason").$type<WorkCancelReason | null>(),
    /** The person who cancelled it from the dashboard or CLI. */
    cancelledByUserId: integer("cancelled_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    /** Claims that ended without completion (lapsed leases). */
    attempts: integer("attempts").notNull().default(0),
    /** The highest event `seq` accepted. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    /** The first response, error, or elicitation of the turn. */
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /**
     * Set while a held turn waits on a person: it posted an `elicitation`
     * mid-turn and keeps running. The next follow-up answers it instead of
     * queueing behind it.
     */
    awaitingAnswerSince: timestamp("awaiting_answer_since", {
      withTimezone: true,
    }),
    /** Follow-ups delivered to this held turn as answers, in order. */
    answers: jsonb("answers").$type<WorkItemPrompt[]>().notNull().default([]),
    /** The daemon's last `status` event state. */
    daemonState: text("daemon_state"),
    usage: jsonb("usage").$type<WorkItemUsage | null>(),
    outcome: jsonb("outcome").$type<WorkItemOutcome | null>(),
    /** What issue hygiene did at claim; null until it ran (first-turn items only). */
    hygiene: jsonb("hygiene").$type<WorkItemHygiene | null>(),
    /**
     * Every write the turn's agent tools made in Linear, in order — the
     * record of those unaudited machine writes, and what the manager's
     * `managed` scope rule reads to know which issues a session created.
     */
    linearWrites: jsonb("linear_writes")
      .$type<LinearWrite[]>()
      .notNull()
      .default([]),
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
