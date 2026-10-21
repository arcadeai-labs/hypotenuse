import type {
  Cancel,
  ClaimRequest,
  CompleteRequest,
  EventsRequest,
  EventsResponse,
  HistoryEntry,
  Offer,
  SessionEvent,
  WorkAssignment,
} from "@hypotenuse/protocol";
import {
  NOT_YOUR_WORK,
  runnerChannel,
  SEQ_REGRESSION,
} from "@hypotenuse/protocol";
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
import { agentActivities } from "../schema/agent_activities";
import {
  type AgentSession,
  type AgentSessionGuidance,
  agentSessions,
} from "../schema/agent_sessions";
import { projectSettings } from "../schema/project_settings";
import type { Runner } from "../schema/runners";
import {
  ACTIVE_WORK_STATUSES,
  HELD_WORK_STATUSES,
  TERMINAL_WORK_STATUSES,
  type WorkCancelReason,
  type WorkItem,
  type WorkItemOutcome,
  type WorkItemStatus,
  workItems,
} from "../schema/work_items";
import {
  enqueueActivity,
  enqueueSessionUpdate,
  type OutboundContent,
  OutboxValidationError,
} from "./ActivityOutboxOps";
import { resolveIssuer } from "./IdentityOps";
import type { TxHandle } from "./ProjectOps";
import { resolveRoutingSettings } from "./ProjectSettingsOps";

/**
 * Work items: one row per **turn** of an agent session, from the moment a
 * person asks to the moment the session is answered.
 *
 * ```
 *  queued ──route──► offered ──claim──► claimed ──events──► running ──complete──► completed | failed | cancelled
 *    ▲                  │ offer lapses     │ lease lapses              │
 *    └──────────────────┴──────────────────┴───────────────────────────┘
 *  queued ── queue timeout ──► expired
 * ```
 *
 * **A turn ends in one place**, {@link finishWorkItem}, reached from
 * `daemon:complete`, cancellation, lease expiry, and the queue timeout. It is
 * also where the session is guaranteed an answer: a turn that ends without a
 * `response`, `error`, or `elicitation` gets one from the server.
 */

/** What the server says when a session is created. */
export function ackBody(issueIdentifier: string | null): string {
  return `On it — finding a runner for ${issueIdentifier ?? "this issue"}.`;
}

/** The thought a follow-up typed during a running turn gets. */
export const QUEUED_BEHIND_BODY =
  "Got it — I'll read this when the current step finishes.";

/** A stop that reached a turn before any runner took it. */
export const STOPPED_BEFORE_START_BODY = "Stopped before starting.";

/** A stop with nothing to stop. */
export const STOPPED_NOTHING_BODY = "Stopped. Nothing was running.";

/** A stop whose runner never confirmed within the grace period. */
export const STOP_UNCONFIRMED_BODY =
  "Stopped. The runner didn't confirm; its last state is unknown.";

/** The server's answer for a turn that completed without one (a daemon bug). */
export const DONE_FALLBACK_BODY = "Done.";

/** The server's answer for a cancelled turn the daemon did not answer. */
export const STOPPED_FALLBACK_BODY = "Stopped.";

/** The server's answer for a failed turn with no message. */
export const FAILED_FALLBACK_BODY = "The run failed before it could answer.";

/** How many lapsed leases a turn survives before it is failed. */
export const MAX_ATTEMPTS = 3;

/** How long a session waiting on Hypotenuse goes quiet before a keepalive. */
export const KEEPALIVE_AFTER_MS = 25 * 60 * 1000;

/** The kinds of event a daemon writes into the outbox. */
const OUTBOX_EVENT_TYPES = new Set([
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
  "plan",
  "summary",
  "external_url",
]);

/** The events that answer a turn. */
const ANSWER_EVENT_TYPES = new Set(["response", "error", "elicitation"]);

/** The events still accepted once a cancel is requested (Linear's `stopping`). */
const STOPPING_EVENT_TYPES = new Set(["response", "error"]);

/**
 * Side effects a transaction leaves for after its commit: sessions whose
 * outbox gained rows, runners to wake with a frame, and whether routing should
 * run.
 */
export interface WorkEffects {
  deliver: Set<number>;
  /** Runner id → the frame to publish on its channel. */
  frames: Map<number, "work" | "cancel">;
  route: boolean;
}

/**
 * An empty {@link WorkEffects}.
 * @returns A fresh one.
 */
export function noEffects(): WorkEffects {
  return { deliver: new Set(), frames: new Map(), route: false };
}

/**
 * Fold one set of effects into another.
 * @param into - The accumulator.
 * @param from - What to add.
 * @returns `into`.
 */
export function mergeEffects(
  into: WorkEffects,
  from: WorkEffects,
): WorkEffects {
  for (const id of from.deliver) into.deliver.add(id);
  for (const [id, frame] of from.frames) {
    // A cancel frame outranks a work frame: both make the daemon heartbeat.
    if (into.frames.get(id) !== "cancel") into.frames.set(id, frame);
  }
  into.route ||= from.route;
  return into;
}

/**
 * Do what a committed transaction left: schedule outbox delivery, publish
 * frames, enqueue `work:route`. Never throws — the change already committed.
 * @param effects - What to do.
 */
export async function applyEffects(effects: WorkEffects): Promise<void> {
  try {
    for (const agentSessionId of effects.deliver) {
      await api.actions.enqueue("activities:deliver", { agentSessionId });
    }
    for (const [runnerId, event] of effects.frames) {
      await api.pubsub.broadcast(
        runnerChannel(runnerId),
        JSON.stringify({ event }),
        "routing",
      );
    }
    if (effects.route) await api.actions.enqueue("work:route", {});
  } catch (error) {
    api.logger.warn("work routing side effects failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Lock a session row.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The row.
 */
export async function lockSession(
  tx: TxHandle,
  agentSessionId: number,
): Promise<AgentSession> {
  const [row] = await tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .for("update");
  if (!row) throw new Error(`No agent session ${agentSessionId}`);
  return row;
}

/**
 * Lock a work item **after its session** — the one lock order every writer
 * keeps: a session, then its work items, then a runner row. Cancellation
 * starts from the session; a claim, an event batch, or the reaper starts from
 * an item; taking the session first in all of them is what keeps a Stop and
 * a daemon's write from deadlocking.
 * @param tx - The transaction.
 * @param workItemId - The item.
 * @param skipLocked - Skip an item another transaction holds, instead of waiting.
 * @returns The item and its session, both locked, or null when there is no
 *   such item (or it was skipped).
 */
export async function lockItemWithSession(
  tx: TxHandle,
  workItemId: number,
  skipLocked = false,
): Promise<{ item: WorkItem; session: AgentSession } | null> {
  const [peek] = await tx
    .select({ agentSessionId: workItems.agentSessionId })
    .from(workItems)
    .where(eq(workItems.id, workItemId));
  if (!peek) return null;
  const session = await lockSession(tx, peek.agentSessionId);
  const query = tx.select().from(workItems).where(eq(workItems.id, workItemId));
  const [item] = skipLocked
    ? await query.for("update", { skipLocked: true })
    : await query.for("update");
  return item ? { item, session } : null;
}

/**
 * A session's work items that have not ended, oldest first.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The rows, locked.
 */
async function liveItems(
  tx: TxHandle,
  agentSessionId: number,
): Promise<WorkItem[]> {
  return tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, agentSessionId),
        sql`${workItems.status} NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
      ),
    )
    .orderBy(asc(workItems.id))
    .for("update");
}

/**
 * Insert the first turn of a new session: queued, not yet prepared (routing
 * reads the issue and chooses the role and repository next).
 * @param tx - The transaction.
 * @param session - The session, just mirrored.
 * @returns The new item.
 */
export async function createSessionCreatedItem(
  tx: TxHandle,
  session: AgentSession,
): Promise<WorkItem> {
  const [item] = await tx
    .insert(workItems)
    .values({
      projectId: session.projectId,
      agentSessionId: session.id,
      kind: "session_created",
      role: session.role,
      preferredUserId: await resolveIssuer(tx, session),
      stickyRunnerId: session.runnerId,
    })
    .returning();
  return item;
}

/** What {@link createOrMergePrompt} did. */
export interface FollowUp {
  item: WorkItem;
  /** True when the prompt joined an already-queued follow-up. */
  merged: boolean;
  /** True when an earlier turn has not ended, so this one waits behind it. */
  behind: boolean;
}

/**
 * Record a follow-up as work: appended to the session's queued `prompt` item
 * when there is one (two messages typed while the agent was busy are one
 * turn's input), else a new `prompt` item carrying the session's role and
 * repository and its sticky runner.
 * @param tx - The transaction.
 * @param session - The session, locked.
 * @param prompt - The inbound activity's id and text.
 * @returns What was done.
 */
export async function createOrMergePrompt(
  tx: TxHandle,
  session: AgentSession,
  prompt: { activityId: number; body: string },
): Promise<FollowUp> {
  const items = await liveItems(tx, session.id);
  const queued = items.find(
    (i) => i.status === "queued" && i.kind === "prompt",
  );
  if (queued) {
    const [item] = await tx
      .update(workItems)
      .set({ prompt: [...(queued.prompt ?? []), prompt] })
      .where(eq(workItems.id, queued.id))
      .returning();
    return {
      item,
      merged: true,
      behind: items.some((i) => i.id !== queued.id),
    };
  }
  const prepared =
    session.role !== null && session.pendingRepositoryChoice === null;
  const [item] = await tx
    .insert(workItems)
    .values({
      projectId: session.projectId,
      agentSessionId: session.id,
      kind: "prompt",
      role: session.role,
      repository: prepared ? session.repository : null,
      repositoryResolved: prepared && sessionRepositoryDecided(session, items),
      prompt: [prompt],
      preferredUserId: await resolveIssuer(tx, session),
      stickyRunnerId: session.runnerId,
    })
    .returning();
  return { item, merged: false, behind: items.length > 0 };
}

/**
 * Whether a prepared session's repository is settled, so a follow-up may copy
 * `session.repository`: it is, once chosen. A worker without one is not — its
 * first turn may have expired before any runner had a checkout, and its next
 * turn must choose again rather than go to any runner at all. A manager may
 * work without one, which is settled once none of its turns is still waiting
 * for a choice.
 * @param session - The session.
 * @param items - Its live items.
 * @returns True when follow-ups may copy `session.repository`.
 */
function sessionRepositoryDecided(
  session: AgentSession,
  items: WorkItem[],
): boolean {
  if (session.repository !== null) return true;
  if (session.role !== "manager") return false;
  return !items.some((i) => !i.repositoryResolved);
}

/** How {@link finishWorkItem} ends a turn. */
export interface FinishOptions {
  status: Extract<
    WorkItemStatus,
    "completed" | "failed" | "cancelled" | "expired"
  >;
  outcome?: WorkItemOutcome | null;
  cancelReason?: WorkCancelReason | null;
  /** What the session is told if the turn has not answered it. */
  fallback?: OutboundContent | null;
  /** Send the fallback in the acknowledgement lane (stops). */
  urgent?: boolean;
}

/**
 * End a turn — **the one place a turn ends**. Marks the item terminal,
 * releases the runner's slot (capacity counts live items only), and, when the
 * turn has not answered the session, enqueues the fallback so the session is
 * never left hanging.
 * @param tx - The transaction.
 * @param item - The item, locked.
 * @param options - How it ends.
 * @returns The effects to apply after commit.
 */
export async function finishWorkItem(
  tx: TxHandle,
  item: WorkItem,
  options: FinishOptions,
): Promise<WorkEffects> {
  const effects = noEffects();
  await tx
    .update(workItems)
    .set({
      status: options.status,
      finishedAt: new Date(),
      waitingReason: null,
      ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
      ...(options.cancelReason ? { cancelReason: options.cancelReason } : {}),
    })
    .where(eq(workItems.id, item.id));
  if (!item.answeredAt && options.fallback) {
    await enqueueActivity(tx, item.agentSessionId, options.fallback, {
      priority: options.urgent ? "ack" : "normal",
    });
    effects.deliver.add(item.agentSessionId);
  }
  effects.route = true;
  return effects;
}

/** What a cancellation needs to know. */
export interface CancelRequest {
  reason: WorkCancelReason;
  /** Tell the person what happened (a stop, the dashboard), or end quietly. */
  announce: boolean;
}

/**
 * Cancel a session's work, as a person's stop (or another disengagement)
 * asks:
 *
 * | Item | Effect |
 * |---|---|
 * | `offered`, or the first `queued` when nothing is under way | `cancelled`; "Stopped before starting." |
 * | `claimed`, `running` | `cancelRequestedAt`; a `cancel` frame; the daemon stops and answers, or the server does after `stopGraceMs` |
 * | every other `queued` | `cancelled` as `superseded`, silently |
 * | nothing at all | "Stopped. Nothing was running." (stops only) |
 *
 * A pending repository question is dropped: the work it was for is gone.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @param request - Why, and whether to say so.
 * @returns The effects to apply after commit.
 */
export async function cancelSessionWork(
  tx: TxHandle,
  agentSessionId: number,
  request: CancelRequest,
): Promise<WorkEffects> {
  const effects = noEffects();
  const session = await lockSession(tx, agentSessionId);
  if (session.pendingRepositoryChoice) {
    await tx
      .update(agentSessions)
      .set({ pendingRepositoryChoice: null })
      .where(eq(agentSessions.id, session.id));
  }
  const items = await liveItems(tx, agentSessionId);
  const stopped: OutboundContent = {
    type: "response",
    body: STOPPED_BEFORE_START_BODY,
  };
  let announced = false;
  const active = items.find((i) =>
    (ACTIVE_WORK_STATUSES as readonly string[]).includes(i.status),
  );

  for (const item of items) {
    if ((HELD_WORK_STATUSES as readonly string[]).includes(item.status)) {
      if (!item.cancelRequestedAt) {
        await tx
          .update(workItems)
          .set({ cancelRequestedAt: new Date(), cancelReason: request.reason })
          .where(eq(workItems.id, item.id));
      }
      if (item.runnerId) effects.frames.set(item.runnerId, "cancel");
      announced = true;
      continue;
    }
    const first = item === active || (!active && !announced);
    mergeEffects(
      effects,
      await finishWorkItem(tx, item, {
        status: "cancelled",
        cancelReason: first ? request.reason : "superseded",
        fallback: first && request.announce ? stopped : null,
        urgent: true,
      }),
    );
    if (item.status === "offered" && item.offeredToRunnerId) {
      effects.frames.set(item.offeredToRunnerId, "work");
    }
    if (first) announced = true;
  }

  if (!announced && request.announce && request.reason === "stop") {
    await enqueueActivity(
      tx,
      agentSessionId,
      { type: "response", body: STOPPED_NOTHING_BODY },
      { priority: "ack" },
    );
    effects.deliver.add(agentSessionId);
  }
  return effects;
}

/**
 * Return a revoked runner's work to the queue, in the revoking transaction:
 * the *work* is still wanted, only this machine is not. Offers to it are
 * withdrawn; claims go back to `queued` without counting an attempt; a turn
 * already being stopped is finished. Sessions it held lose their stickiness —
 * its worktree is gone with it — so the next claimant starts fresh.
 * @param tx - The revoking transaction.
 * @param runnerIds - The runners revoked.
 * @returns The effects to apply after commit.
 */
export async function requeueRunnerWork(
  tx: TxHandle,
  runnerIds: number[],
): Promise<WorkEffects> {
  const effects = noEffects();
  if (runnerIds.length === 0) return effects;
  const theirs = or(
    and(
      eq(workItems.status, "offered"),
      inArray(workItems.offeredToRunnerId, runnerIds),
    ),
    and(
      inArray(workItems.status, [...HELD_WORK_STATUSES]),
      inArray(workItems.runnerId, runnerIds),
    ),
  );
  // Sessions first — the lock order every writer keeps — in id order, so two
  // revocations take them in the same order too.
  const sessionIds = await tx
    .selectDistinct({ id: workItems.agentSessionId })
    .from(workItems)
    .where(or(theirs, inArray(workItems.stickyRunnerId, runnerIds)));
  const stuck = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(inArray(agentSessions.runnerId, runnerIds));
  const toLock = [...new Set([...sessionIds, ...stuck].map((r) => r.id))].sort(
    (a, b) => a - b,
  );
  if (toLock.length > 0) {
    await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(inArray(agentSessions.id, toLock))
      .orderBy(asc(agentSessions.id))
      .for("update");
  }
  const items = await tx
    .select()
    .from(workItems)
    .where(theirs)
    .orderBy(asc(workItems.id))
    .for("update");
  for (const item of items) {
    if (item.cancelRequestedAt) {
      mergeEffects(
        effects,
        await finishWorkItem(tx, item, {
          status: "cancelled",
          fallback: { type: "response", body: STOPPED_FALLBACK_BODY },
          urgent: true,
        }),
      );
      continue;
    }
    await tx
      .update(workItems)
      .set(requeuedColumns())
      .where(eq(workItems.id, item.id));
  }
  await tx
    .update(agentSessions)
    .set({ runnerId: null })
    .where(inArray(agentSessions.runnerId, runnerIds));
  await tx
    .update(workItems)
    .set({ stickyRunnerId: null })
    .where(
      and(
        inArray(workItems.stickyRunnerId, runnerIds),
        eq(workItems.status, "queued"),
      ),
    );
  effects.route = true;
  return effects;
}

/**
 * The columns that put an item back in the queue.
 * @returns The update.
 */
function requeuedColumns() {
  return {
    status: "queued" as const,
    offeredToRunnerId: null,
    offerExpiresAt: null,
    runnerId: null,
    claimedAt: null,
    leaseExpiresAt: null,
    agentId: null,
    fresh: null,
    queuedAt: new Date(),
    waitingReason: null,
  };
}

/**
 * What a heartbeat answers about work: the offers standing for this runner,
 * the held items it must cancel, and the `active` items it reports that the
 * server no longer considers its own. Renews the lease of every reported item
 * the runner does hold.
 * @param tx - The heartbeat's transaction.
 * @param runnerId - The runner.
 * @param active - The work item ids the daemon says it holds.
 * @returns Offers, cancels, and unknown ids.
 */
export async function heartbeatWork(
  tx: TxHandle,
  runnerId: number,
  active: number[],
): Promise<{ offers: Offer[]; cancels: Cancel[]; unknownActive: number[] }> {
  const now = new Date();
  const held = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.runnerId, runnerId),
        inArray(workItems.status, [...HELD_WORK_STATUSES]),
      ),
    );
  const heldIds = new Set(held.map((i) => i.id));
  const renew = active.filter((id) => heldIds.has(id));
  if (renew.length > 0) {
    await tx
      .update(workItems)
      .set({ leaseExpiresAt: new Date(now.getTime() + config.runners.leaseMs) })
      .where(inArray(workItems.id, renew));
  }
  const offered = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.offeredToRunnerId, runnerId),
        eq(workItems.status, "offered"),
        gt(workItems.offerExpiresAt, now),
      ),
    )
    .orderBy(asc(workItems.id));
  return {
    offers: offered.map((i) => ({
      workItemId: i.id,
      agentSessionId: i.agentSessionId,
      kind: i.kind,
      role: i.role ?? "worker",
      offerExpiresAt: i.offerExpiresAt!.getTime(),
    })),
    cancels: held
      .filter((i) => i.cancelRequestedAt)
      .map((i) => ({
        workItemId: i.id,
        reason: i.cancelReason ?? "stop",
      })),
    unknownActive: active.filter((id) => !heldIds.has(id)),
  };
}

/** A refusal `daemon:*` answers as a raw response (Keryx has no 409). */
export class DaemonRefusal extends Error {
  /**
   * @param status - The HTTP status.
   * @param type - The `error.type`.
   * @param message - What went wrong.
   * @param extra - More fields for the envelope.
   */
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DaemonRefusal";
  }

  /**
   * The response, in Keryx's envelope.
   * @returns The response.
   */
  toResponse(): Response {
    return Response.json(
      { error: { type: this.type, message: this.message, ...this.extra } },
      { status: this.status },
    );
  }
}

/**
 * The refusal for an item this runner does not hold.
 * @param workItemId - The item.
 * @returns A 409 `NOT_YOUR_WORK`.
 */
function notYourWork(workItemId: number): DaemonRefusal {
  return new DaemonRefusal(
    409,
    NOT_YOUR_WORK,
    `Work item ${workItemId} is not held by this runner. Stop work on it without writing further.`,
    { workItemId },
  );
}

/**
 * Lock an item this runner holds.
 * @param tx - The transaction.
 * @param runnerId - The runner.
 * @param workItemId - The item.
 * @returns The item, locked.
 * @throws {DaemonRefusal} `NOT_YOUR_WORK`.
 */
async function lockHeldItem(
  tx: TxHandle,
  runnerId: number,
  workItemId: number,
): Promise<WorkItem> {
  const item = (await lockItemWithSession(tx, workItemId))?.item;
  if (
    !item ||
    item.runnerId !== runnerId ||
    !(HELD_WORK_STATUSES as readonly string[]).includes(item.status)
  ) {
    throw notYourWork(workItemId);
  }
  return item;
}

/** What {@link claimWork} answers. */
export interface ClaimResult {
  assignment: WorkAssignment | null;
  effects: WorkEffects;
}

/**
 * Claim an offer: the oldest one standing for this runner (or one of the
 * named items), taken `FOR UPDATE SKIP LOCKED` so two claims never take one
 * item. Capacity is re-checked under the runner's row lock. Stickiness is
 * established here: the session's `runnerId` becomes this runner, and the
 * turn is `fresh` (a new worktree, history replayed) unless this runner
 * already held the session.
 *
 * A claim naming an item this runner already holds answers the same
 * assignment again, so a claim whose answer was lost is safe to repeat.
 * @param tx - The transaction.
 * @param runner - The claiming runner.
 * @param request - Which items, if any.
 * @returns The assignment, or null when there was nothing to claim.
 */
export async function claimWork(
  tx: TxHandle,
  runner: Runner,
  request: ClaimRequest,
): Promise<ClaimResult> {
  const effects = noEffects();
  const now = new Date();
  const lease = new Date(now.getTime() + config.runners.leaseMs);
  const ids = request.workItemIds;

  if (ids && ids.length > 0) {
    const [held] = await tx
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          inArray(workItems.id, ids),
          eq(workItems.runnerId, runner.id),
          inArray(workItems.status, [...HELD_WORK_STATUSES]),
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(1);
    const locked = held ? await lockItemWithSession(tx, held.id) : null;
    if (
      locked &&
      locked.item.runnerId === runner.id &&
      (HELD_WORK_STATUSES as readonly string[]).includes(locked.item.status)
    ) {
      const [renewed] = await tx
        .update(workItems)
        .set({ leaseExpiresAt: lease })
        .where(eq(workItems.id, locked.item.id))
        .returning();
      return {
        assignment: await buildAssignment(tx, renewed, runner),
        effects,
      };
    }
  }

  const candidates = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.status, "offered"),
        eq(workItems.offeredToRunnerId, runner.id),
        gt(workItems.offerExpiresAt, now),
        ids && ids.length > 0 ? inArray(workItems.id, ids) : undefined,
      ),
    )
    .orderBy(asc(workItems.id))
    .limit(10);
  let offered: { item: WorkItem; session: AgentSession } | null = null;
  for (const { id } of candidates) {
    const locked = await lockItemWithSession(tx, id, true);
    if (
      locked &&
      locked.item.status === "offered" &&
      locked.item.offeredToRunnerId === runner.id &&
      locked.item.offerExpiresAt !== null &&
      locked.item.offerExpiresAt > now
    ) {
      offered = locked;
      break;
    }
  }
  if (!offered) return { assignment: null, effects };

  // The runner's own row lock serializes its claims, so the count below sees
  // every claim it has made.
  const [capacity] = await tx
    .execute<{
      max_parallel: number | null;
      held: number;
    }>(sql`
    SELECT (r.limits->>'maxParallelJobs')::int AS max_parallel,
      (SELECT count(*)::int FROM work_items w
        WHERE w.runner_id = r.id AND w.status IN ('claimed', 'running')) AS held
    FROM runners r WHERE r.id = ${runner.id} FOR UPDATE
  `)
    .then((r) => r.rows);
  if (
    !capacity ||
    capacity.max_parallel === null ||
    Number(capacity.held) >= Number(capacity.max_parallel)
  ) {
    return { assignment: null, effects };
  }

  const { item, session } = offered;
  const fresh = session.runnerId !== runner.id;
  const [claimed] = await tx
    .update(workItems)
    .set({
      status: "claimed",
      runnerId: runner.id,
      claimedAt: now,
      leaseExpiresAt: lease,
      fresh,
      waitingReason: null,
    })
    .where(eq(workItems.id, item.id))
    .returning();
  if (session.runnerId !== runner.id) {
    await tx
      .update(agentSessions)
      .set({ runnerId: runner.id })
      .where(eq(agentSessions.id, session.id));
  }
  return { assignment: await buildAssignment(tx, claimed, runner), effects };
}

/**
 * A branch name for a session: `hypotenuse/eng-123-fix-checkout-rounding`.
 * A hint — the daemon may already have one for the session.
 * @param session - The session.
 * @returns The name, or null without an issue identifier.
 */
export function branchHint(session: AgentSession): string | null {
  const id = session.issueIdentifier?.toLowerCase();
  if (!id) return null;
  const slug = (session.issueTitle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `hypotenuse/${id}${slug ? `-${slug}` : ""}`;
}

/**
 * Guidance in the order an agent should weigh it: nearest team first, then
 * the workspace's.
 * @param guidance - As Linear sent it.
 * @returns The ordered list.
 */
export function orderGuidance(
  guidance: AgentSessionGuidance[] | null,
): WorkAssignment["guidance"] {
  const entries = (guidance ?? []).map((g) => {
    const team = g.origin?.type === "Team";
    const key = (g.origin?.team as { key?: string } | undefined)?.key ?? null;
    return {
      origin: team ? ("team" as const) : ("workspace" as const),
      teamKey: team ? key : null,
      body: g.body,
    };
  });
  return [
    ...entries.filter((g) => g.origin === "team"),
    ...entries.filter((g) => g.origin === "workspace"),
  ];
}

/**
 * The session's conversation so far, rebuilt from activities — never from
 * comments, which can be edited. Both directions; only what was delivered or
 * received; in `seq` order.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The history.
 */
export async function rebuildHistory(
  tx: TxHandle,
  agentSessionId: number,
): Promise<HistoryEntry[]> {
  const rows = await tx
    .select()
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.agentSessionId, agentSessionId),
        eq(agentActivities.kind, "activity"),
        inArray(agentActivities.deliveryStatus, ["sent", "received"]),
      ),
    )
    .orderBy(asc(agentActivities.seq));
  return rows.map((row) => {
    const content = row.content as Record<string, unknown>;
    const body =
      typeof content.body === "string"
        ? content.body
        : row.contentType === "action"
          ? [content.action, content.parameter, content.result]
              .filter((part) => typeof part === "string" && part)
              .join(" — ")
          : null;
    return {
      seq: row.seq,
      activityId: row.id,
      direction: row.direction,
      type: row.contentType ?? row.kind,
      body,
      signal: row.signal,
    };
  });
}

/**
 * The dashboard's page for a session.
 * @param agentSessionId - The session.
 * @returns The URL.
 */
export function dashboardSessionUrl(agentSessionId: number): string {
  return `${config.cliAuth.appUrl.replace(/\/+$/, "")}/sessions/${agentSessionId}`;
}

/**
 * Everything the daemon needs to run a claimed turn.
 * @param tx - The transaction.
 * @param item - The claimed item.
 * @param runner - The runner holding it.
 * @returns The assignment.
 */
export async function buildAssignment(
  tx: TxHandle,
  item: WorkItem,
  runner: Runner,
): Promise<WorkAssignment> {
  const [session] = await tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, item.agentSessionId));
  const snapshot = session.issueSnapshot;
  const repository = item.repository
    ? {
        remote: item.repository,
        baseBranch:
          runner.repositories.find((r) => r.remote === item.repository)
            ?.baseBranch ?? null,
      }
    : null;
  return {
    workItemId: item.id,
    agentSessionId: session.id,
    type: session.type,
    externalSessionId: session.externalSessionId,
    externalSessionUrl: session.externalUrl,
    dashboardUrl: dashboardSessionUrl(session.id),
    kind: item.kind,
    role: item.role ?? "worker",
    agentId: item.agentId,
    fresh: item.fresh ?? true,
    repository,
    branch: repository ? branchHint(session) : null,
    issue: {
      id: snapshot?.id ?? session.externalIssueId,
      identifier: snapshot?.identifier ?? session.issueIdentifier,
      title: snapshot?.title ?? session.issueTitle,
      description: snapshot?.description ?? null,
      url: snapshot?.url ?? session.issueUrl,
      teamKey: snapshot?.teamKey ?? session.teamKey,
      labels: snapshot?.labels ?? [],
      state: snapshot?.state ?? null,
      parent: snapshot?.parent ?? null,
      project: snapshot?.project ?? null,
    },
    instruction: session.instruction,
    promptContext: session.promptContext,
    guidance: orderGuidance(session.guidance),
    previousComments: session.previousComments,
    history: await rebuildHistory(tx, session.id),
    prompt:
      item.kind === "prompt"
        ? (item.prompt ?? []).map((p) => ({
            activityId: p.activityId,
            body: p.body,
          }))
        : null,
    origin: session.origin,
    humanDelegated:
      session.origin === "delegation" && session.creatorExternalUserId !== null,
    leaseExpiresAt: item.leaseExpiresAt!.getTime(),
  };
}

/** What {@link applyEvents} answers. */
export interface EventsResult {
  response: EventsResponse;
  effects: WorkEffects;
}

/**
 * The outbound content an event becomes.
 * @param event - A thought, action, elicitation, response, or error.
 * @returns Linear's content object.
 */
function activityContent(event: SessionEvent): OutboundContent {
  switch (event.type) {
    case "action":
      return {
        type: "action",
        action: event.action,
        parameter: event.parameter,
        ...(event.result !== undefined ? { result: event.result } : {}),
      };
    case "thought":
    case "elicitation":
    case "response":
    case "error":
      return { type: event.type, body: event.body };
    default:
      throw new Error(`${event.type} is not an activity`);
  }
}

/**
 * Take a daemon's events for a turn it holds, in `seq` order, into the
 * outbox — each one's `eventId` becoming the activity's client id, so a
 * resent batch is idempotent end to end.
 *
 * - The first call moves the item `claimed → running`; every call renews the
 *   lease.
 * - Once a cancel is requested, only `response` and `error` are accepted
 *   (Linear's `stopping` allows nothing else); others are dropped and counted.
 * - An event already recorded is a duplicate; a new event at or below the
 *   highest `seq` taken is a regression (409), and so is the whole batch.
 * - `usage` and `status` are kept on the item for the dashboard.
 * @param tx - The transaction.
 * @param runnerId - The runner.
 * @param request - The batch, already schema-valid.
 * @returns The counts and effects.
 * @throws {DaemonRefusal} `NOT_YOUR_WORK` or `SEQ_REGRESSION`.
 * @throws {TypedError} 406 naming the event index the outbox refused.
 */
export async function applyEvents(
  tx: TxHandle,
  runnerId: number,
  request: EventsRequest,
): Promise<EventsResult> {
  const effects = noEffects();
  const item = await lockHeldItem(tx, runnerId, request.workItemId);
  const ordered = request.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.seq - b.event.seq);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].event.seq === ordered[i - 1].event.seq) {
      throw new TypedError({
        message: `Events ${ordered[i - 1].index} and ${ordered[i].index} share seq ${ordered[i].event.seq}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: `events.${ordered[i].index}.seq`,
      });
    }
  }

  const eventIds = ordered.map((o) => o.event.eventId);
  const existing = await tx
    .select({
      clientActivityId: agentActivities.clientActivityId,
      agentSessionId: agentActivities.agentSessionId,
    })
    .from(agentActivities)
    .where(inArray(agentActivities.clientActivityId, eventIds));
  const recorded = new Map(
    existing.map((r) => [r.clientActivityId, r.agentSessionId]),
  );

  const response: EventsResponse = {
    accepted: 0,
    duplicates: 0,
    dropped: 0,
    cancelRequested: item.cancelRequestedAt !== null,
  };
  let lastSeq = item.lastEventSeq;
  let answered = item.answeredAt;
  let usage = item.usage;
  let daemonState = item.daemonState;

  for (const { event, index } of ordered) {
    const owner = recorded.get(event.eventId);
    if (owner !== undefined) {
      if (owner !== item.agentSessionId) {
        throw new TypedError({
          message: `Event ${index}'s eventId is already used`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: `events.${index}.eventId`,
        });
      }
      response.duplicates++;
      continue;
    }
    if (event.seq <= item.lastEventSeq) {
      if (event.type === "usage" || event.type === "status") {
        // Not recorded anywhere to compare with: a resend of a batch.
        response.duplicates++;
        continue;
      }
      throw new DaemonRefusal(
        409,
        SEQ_REGRESSION,
        `Event ${index} has seq ${event.seq}, but seq ${item.lastEventSeq} was already accepted for work item ${item.id}.`,
        { workItemId: item.id, index, lastSeq: item.lastEventSeq },
      );
    }
    lastSeq = Math.max(lastSeq, event.seq);
    if (item.cancelRequestedAt && !STOPPING_EVENT_TYPES.has(event.type)) {
      response.dropped++;
      continue;
    }
    try {
      await recordEvent(tx, item, event);
    } catch (e) {
      if (e instanceof OutboxValidationError) {
        throw new TypedError({
          message: `Event ${index}: ${e.message}`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: `events.${index}`,
        });
      }
      throw e;
    }
    if (OUTBOX_EVENT_TYPES.has(event.type)) {
      effects.deliver.add(item.agentSessionId);
    }
    if (ANSWER_EVENT_TYPES.has(event.type) && !answered) answered = new Date();
    if (event.type === "usage") {
      const { eventId: _e, seq: _s, at: _a, type: _t, ...counts } = event;
      usage = counts;
    }
    if (event.type === "status") daemonState = event.state;
    response.accepted++;
  }

  await tx
    .update(workItems)
    .set({
      status: "running",
      leaseExpiresAt: new Date(Date.now() + config.runners.leaseMs),
      lastEventSeq: lastSeq,
      answeredAt: answered,
      usage,
      daemonState,
    })
    .where(eq(workItems.id, item.id));
  return { response, effects };
}

/**
 * Write one accepted event: an activity or a session update in the outbox,
 * keyed by its `eventId`, or nothing (usage and status live on the item).
 * @param tx - The transaction.
 * @param item - The item.
 * @param event - The event.
 */
async function recordEvent(
  tx: TxHandle,
  item: WorkItem,
  event: SessionEvent,
): Promise<void> {
  const sessionId = item.agentSessionId;
  const clientActivityId = event.eventId;
  switch (event.type) {
    case "thought":
    case "action":
      await enqueueActivity(tx, sessionId, activityContent(event), {
        ephemeral: event.ephemeral,
        clientActivityId,
      });
      return;
    case "elicitation":
      await enqueueActivity(tx, sessionId, activityContent(event), {
        ...(event.signal
          ? {
              signal: event.signal,
              signalMetadata: event.signalMetadata as Record<string, unknown>,
            }
          : {}),
        clientActivityId,
      });
      return;
    case "response":
    case "error":
      await enqueueActivity(tx, sessionId, activityContent(event), {
        clientActivityId,
      });
      return;
    case "plan":
      await enqueueSessionUpdate(
        tx,
        sessionId,
        {
          plan: event.entries.map((entry) => ({
            content: entry.content,
            status:
              entry.status === "in_progress" ? "inProgress" : entry.status,
          })),
        },
        { clientActivityId },
      );
      return;
    case "summary":
      await enqueueSessionUpdate(
        tx,
        sessionId,
        { summary: event.title },
        { clientActivityId },
      );
      return;
    case "external_url":
      await enqueueSessionUpdate(
        tx,
        sessionId,
        { addedExternalUrls: [{ label: event.label, url: event.url }] },
        { clientActivityId },
      );
      return;
    case "usage":
    case "status":
      return;
  }
}

/** What {@link completeWork} answers. */
export interface CompleteResult {
  alreadyTerminal: boolean;
  effects: WorkEffects;
}

/**
 * End a turn the daemon reports finished, guaranteeing the session an answer
 * if the turn gave none: "Done." for `completed` (a daemon bug, logged), the
 * error for `failed`, "Stopped." for `cancelled`. Completing a terminal item
 * again is harmless — including the late completion of a turn the server
 * already stopped after its grace period.
 * @param tx - The transaction.
 * @param runnerId - The runner.
 * @param request - The completion.
 * @returns Whether it was already terminal, and the effects.
 * @throws {DaemonRefusal} `NOT_YOUR_WORK` for an item another runner holds.
 */
export async function completeWork(
  tx: TxHandle,
  runnerId: number,
  request: CompleteRequest,
): Promise<CompleteResult> {
  const item = (await lockItemWithSession(tx, request.workItemId))?.item;
  if (!item) throw notYourWork(request.workItemId);
  if ((TERMINAL_WORK_STATUSES as readonly string[]).includes(item.status)) {
    const ours =
      item.runnerId === runnerId || item.offeredToRunnerId === runnerId;
    if (!ours) throw notYourWork(request.workItemId);
    return { alreadyTerminal: true, effects: noEffects() };
  }
  if (
    item.runnerId !== runnerId ||
    !(HELD_WORK_STATUSES as readonly string[]).includes(item.status)
  ) {
    throw notYourWork(request.workItemId);
  }
  if (request.outcome === "completed" && !item.answeredAt) {
    api.logger.warn("a turn completed without answering its session", {
      workItemId: item.id,
      runnerId,
    });
  }
  const fallback: OutboundContent =
    request.outcome === "completed"
      ? { type: "response", body: DONE_FALLBACK_BODY }
      : request.outcome === "failed"
        ? {
            type: "error",
            body: request.error?.trim() || FAILED_FALLBACK_BODY,
          }
        : { type: "response", body: STOPPED_FALLBACK_BODY };
  const effects = await finishWorkItem(tx, item, {
    status: request.outcome,
    outcome: {
      outcome: request.outcome,
      error: request.error ?? null,
      acpSessionId: request.acpSessionId ?? null,
      branch: request.branch ?? null,
    },
    fallback,
    urgent: request.outcome === "cancelled",
  });
  return { alreadyTerminal: false, effects };
}

/** What one {@link reapWork} pass did. */
export interface ReapResult {
  requeued: number[];
  failed: number[];
  stopped: number[];
  effects: WorkEffects;
}

/**
 * The lease clock's work half:
 *
 * - a claim whose lease lapsed goes back to `queued` with `attempts + 1`,
 *   keeping its stickiness (a laptop that slept for a minute should get its
 *   session back); past {@link MAX_ATTEMPTS} it is `failed` with an `error`;
 * - a turn being stopped whose runner has not confirmed within the project's
 *   `stopGraceMs` is ended by the server, which says so.
 * @returns What it did, and the effects to apply.
 */
export async function reapWork(): Promise<ReapResult> {
  const result: ReapResult = {
    requeued: [],
    failed: [],
    stopped: [],
    effects: noEffects(),
  };
  const now = new Date();
  const lapsed = await api.db.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        inArray(workItems.status, [...HELD_WORK_STATUSES]),
        lt(workItems.leaseExpiresAt, now),
      ),
    );
  for (const { id } of lapsed) {
    await api.db.db.transaction(async (tx) => {
      const item = (await lockItemWithSession(tx, id, true))?.item;
      if (
        !item ||
        !(HELD_WORK_STATUSES as readonly string[]).includes(item.status) ||
        !item.leaseExpiresAt ||
        item.leaseExpiresAt >= now
      ) {
        return;
      }
      if (item.cancelRequestedAt) {
        mergeEffects(
          result.effects,
          await finishWorkItem(tx, item, {
            status: "cancelled",
            fallback: { type: "response", body: STOP_UNCONFIRMED_BODY },
            urgent: true,
          }),
        );
        result.stopped.push(item.id);
        return;
      }
      const attempts = item.attempts + 1;
      if (attempts > MAX_ATTEMPTS) {
        await tx
          .update(workItems)
          .set({ attempts })
          .where(eq(workItems.id, item.id));
        mergeEffects(
          result.effects,
          await finishWorkItem(tx, item, {
            status: "failed",
            fallback: {
              type: "error",
              body: `This turn was lost ${attempts} times — the runner stopped answering each time it took it — so I've stopped retrying. Prompt again to try once more.`,
            },
          }),
        );
        result.failed.push(item.id);
        return;
      }
      await tx
        .update(workItems)
        .set({ ...requeuedColumns(), attempts })
        .where(eq(workItems.id, item.id));
      result.requeued.push(item.id);
      result.effects.route = true;
    });
  }

  const stopping = await api.db.db
    .select({ id: workItems.id, routing: projectSettings.routing })
    .from(workItems)
    .leftJoin(
      projectSettings,
      eq(projectSettings.projectId, workItems.projectId),
    )
    .where(
      and(
        inArray(workItems.status, [...HELD_WORK_STATUSES]),
        isNotNull(workItems.cancelRequestedAt),
      ),
    );
  for (const { id, routing } of stopping) {
    if (result.stopped.includes(id)) continue;
    const grace = resolveRoutingSettings({
      routing: routing ?? {},
    }).stopGraceMs;
    await api.db.db.transaction(async (tx) => {
      const item = (await lockItemWithSession(tx, id, true))?.item;
      if (
        !item?.cancelRequestedAt ||
        !(HELD_WORK_STATUSES as readonly string[]).includes(item.status) ||
        item.cancelRequestedAt.getTime() + grace > now.getTime()
      ) {
        return;
      }
      const answeredSinceCancel =
        item.answeredAt !== null &&
        item.answeredAt.getTime() >= item.cancelRequestedAt.getTime();
      mergeEffects(
        result.effects,
        await finishWorkItem(
          tx,
          { ...item, answeredAt: answeredSinceCancel ? item.answeredAt : null },
          {
            status: "cancelled",
            fallback: { type: "response", body: STOP_UNCONFIRMED_BODY },
            urgent: true,
          },
        ),
      );
      result.stopped.push(item.id);
    });
  }
  return result;
}

/**
 * Shape a work item for the API, timestamps as epoch ms.
 * @param item - The row.
 * @returns The serialized item.
 */
export function serializeWorkItem(item: WorkItem) {
  const ms = (d: Date | null) => (d ? d.getTime() : null);
  return {
    id: item.id,
    projectId: item.projectId,
    agentSessionId: item.agentSessionId,
    kind: item.kind,
    role: item.role,
    status: item.status,
    repository: item.repository,
    runnerId: item.runnerId,
    offeredToRunnerId: item.offeredToRunnerId,
    agentId: item.agentId,
    attempts: item.attempts,
    waitingReason: item.waitingReason,
    cancelReason: item.cancelReason,
    cancelRequestedAt: ms(item.cancelRequestedAt),
    daemonState: item.daemonState,
    usage: item.usage,
    outcome: item.outcome,
    createdAt: item.createdAt.getTime(),
    claimedAt: ms(item.claimedAt),
    finishedAt: ms(item.finishedAt),
  };
}

/** {@link serializeWorkItem}'s output. */
export type SerializedWorkItem = ReturnType<typeof serializeWorkItem>;
