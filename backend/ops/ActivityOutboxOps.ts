import { and, asc, eq, lte, sql } from "drizzle-orm";
import { api, config } from "keryx";
import {
  type ActivityContentType,
  type ActivityPriority,
  type ActivitySignal,
  type AgentActivity,
  agentActivities,
} from "../schema/agent_activities";
import {
  type AgentSession,
  type AgentSessionExternalUrl,
  type AgentSessionPlanStep,
  agentSessions,
} from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import { statusColumns, statusImpliedBy } from "./AgentSessionOps";
import { takeLinearToken } from "./LinearBucketOps";
import {
  LinearGraphQLError,
  LinearIntegrationUnavailableError,
  LinearRateLimitedError,
  linearRequest,
} from "./LinearOps";
import { acquireLock, releaseLock } from "./LockOps";
import {
  CreateAgentActivity,
  type LinearAgentSessionUpdateInput,
  UpdateAgentSession,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";
import { broadcastSessionActivity } from "./SessionChannelOps";

/**
 * The activity outbox: **everything Hypotenuse writes to a Linear agent
 * session goes through here.**
 *
 * A caller appends inside its own transaction ({@link enqueueActivity},
 * {@link enqueueSessionUpdate}) and, after commit, schedules delivery
 * ({@link scheduleDelivery}). `activities:deliver` then sends each session's
 * rows in `seq` order ({@link deliverSession}), one session at a time under a
 * lease, many sessions in parallel. Each `agentActivityCreate` carries the
 * row's `clientActivityId` as its `id`, so a send whose response was lost is
 * retried with the same id and Linear refuses the duplicate — which this
 * module counts as success.
 *
 * Why a table and not a direct call: Linear holds an agent to a 10-second
 * acknowledgement and a 5,000-requests-an-hour budget, and a direct call from
 * whatever noticed something has no ordering, no retry, and no budget.
 */

/** A row the outbox refuses at enqueue: our bug, never sent to Linear. */
export class OutboxValidationError extends Error {
  /**
   * @param message - What was wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "OutboxValidationError";
  }
}

/** The agent-written content types (a `prompt` is a person's). */
const OUTBOUND_TYPES = [
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
] as const;

/** One outbound activity's content, in Linear's shape. */
export type OutboundContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

/** What {@link enqueueActivity} takes besides the content. */
export interface EnqueueActivityOptions {
  /** Only legal on `thought` and `action`. Replaced by the next activity in Linear. */
  ephemeral?: boolean;
  /** `select` or `auth`, on an `elicitation`. */
  signal?: Extract<ActivitySignal, "select" | "auth">;
  signalMetadata?: Record<string, unknown>;
  /** Defaults to `bulk` for an ephemeral row and `normal` otherwise. */
  priority?: ActivityPriority;
  /**
   * The row's client id, when the caller has one — a daemon's `eventId`, so
   * its resent batch is idempotent end to end. Generated otherwise.
   */
  clientActivityId?: string;
}

/** What {@link enqueueSessionUpdate} takes. */
export interface SessionUpdateInput {
  plan?: AgentSessionPlanStep[] | null;
  summary?: string | null;
  addedExternalUrls?: AgentSessionExternalUrl[];
  removedExternalUrls?: string[];
}

/** Plan step statuses Linear accepts. */
const PLAN_STATUSES = ["pending", "inProgress", "completed", "canceled"];

/**
 * A non-empty string.
 * @param value - Anything.
 * @returns True for a string with non-whitespace content.
 */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check an outbound activity against what Linear accepts, so a malformed one
 * fails here, in the caller's transaction, instead of as a Linear validation
 * error after it has taken its place in the session's order.
 * @param content - The content.
 * @param options - Ephemeral and signal.
 * @throws {OutboxValidationError} When Linear would refuse it.
 */
export function validateActivity(
  content: OutboundContent,
  options: EnqueueActivityOptions,
): void {
  const type = (content as { type?: unknown }).type;
  if (!(OUTBOUND_TYPES as readonly unknown[]).includes(type)) {
    throw new OutboxValidationError(
      `An agent cannot write a ${String(type)} activity`,
    );
  }
  if (content.type === "action") {
    if (!nonEmpty(content.action) || !nonEmpty(content.parameter)) {
      throw new OutboxValidationError(
        "An action needs a non-empty action and parameter",
      );
    }
  } else if (!nonEmpty(content.body)) {
    throw new OutboxValidationError(`A ${content.type} needs a non-empty body`);
  }
  if (options.ephemeral && !["thought", "action"].includes(content.type)) {
    throw new OutboxValidationError(
      `Only a thought or an action can be ephemeral, not a ${content.type}`,
    );
  }
  if (options.signal) {
    if (!["select", "auth"].includes(options.signal)) {
      throw new OutboxValidationError(
        `An agent cannot send the ${options.signal} signal`,
      );
    }
    if (content.type !== "elicitation") {
      throw new OutboxValidationError(
        `The ${options.signal} signal belongs on an elicitation`,
      );
    }
  }
}

/**
 * Check a session update against what Linear accepts.
 * @param input - The update.
 * @throws {OutboxValidationError} When Linear would refuse it.
 */
export function validateSessionUpdate(input: SessionUpdateInput): void {
  const keys = Object.keys(input).filter(
    (k) => input[k as keyof SessionUpdateInput] !== undefined,
  );
  if (keys.length === 0) {
    throw new OutboxValidationError("A session update must change something");
  }
  for (const key of keys) {
    if (
      !["plan", "summary", "addedExternalUrls", "removedExternalUrls"].includes(
        key,
      )
    ) {
      throw new OutboxValidationError(
        `Hypotenuse does not write ${key} on a session`,
      );
    }
  }
  if (input.summary !== undefined && input.summary !== null) {
    if (
      !nonEmpty(input.summary) ||
      input.summary.length > 255 ||
      /[\r\n\0]/.test(input.summary)
    ) {
      throw new OutboxValidationError(
        "A session summary is one line of 1 to 255 characters",
      );
    }
  }
  if (input.plan !== undefined && input.plan !== null) {
    if (
      !Array.isArray(input.plan) ||
      input.plan.some(
        (step) =>
          !nonEmpty(step?.content) || !PLAN_STATUSES.includes(step?.status),
      )
    ) {
      throw new OutboxValidationError(
        "A plan is a list of { content, status } steps",
      );
    }
  }
  for (const link of input.addedExternalUrls ?? []) {
    if (!nonEmpty(link?.label) || !URL.canParse(link?.url ?? "")) {
      throw new OutboxValidationError(
        "An external URL needs a label and a URL",
      );
    }
  }
}

/**
 * Lock a session row and take its next `seq`. Every append goes through here,
 * so two writers to one session serialize and `seq` has no gaps or repeats.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The next sequence number.
 */
async function nextSeq(tx: TxHandle, agentSessionId: number): Promise<number> {
  const [locked] = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .for("update");
  if (!locked) throw new Error(`No agent session ${agentSessionId}`);
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${agentActivities.seq}), 0)` })
    .from(agentActivities)
    .where(eq(agentActivities.agentSessionId, agentSessionId));
  return Number(max) + 1;
}

/**
 * Append an outbound activity to a session's outbox, inside the caller's
 * transaction. Any still-pending ephemeral activity before it is superseded:
 * Linear replaces an ephemeral activity with the next one anyway, so sending
 * it would spend a request on something shown for a few milliseconds.
 * @param tx - The caller's transaction.
 * @param agentSessionId - The session.
 * @param content - Linear's content object.
 * @param options - Ephemeral, signal, priority.
 * @returns The new row.
 * @throws {OutboxValidationError} When Linear would refuse it.
 */
export async function enqueueActivity(
  tx: TxHandle,
  agentSessionId: number,
  content: OutboundContent,
  options: EnqueueActivityOptions = {},
): Promise<AgentActivity> {
  validateActivity(content, options);
  const seq = await nextSeq(tx, agentSessionId);

  await tx
    .update(agentActivities)
    .set({ deliveryStatus: "superseded" })
    .where(
      and(
        eq(agentActivities.agentSessionId, agentSessionId),
        eq(agentActivities.direction, "outbound"),
        eq(agentActivities.deliveryStatus, "pending"),
        eq(agentActivities.ephemeral, true),
      ),
    );

  const [row] = await tx
    .insert(agentActivities)
    .values({
      agentSessionId,
      seq,
      direction: "outbound",
      kind: "activity",
      contentType: content.type,
      content: { ...content },
      ephemeral: options.ephemeral ?? false,
      signal: options.signal ?? null,
      signalMetadata: options.signalMetadata ?? null,
      clientActivityId: options.clientActivityId ?? crypto.randomUUID(),
      priority: options.priority ?? (options.ephemeral ? "bulk" : "normal"),
      deliveryStatus: "pending",
    })
    .returning();
  return row;
}

/**
 * Append a plan, summary, or external-URL change to a session's outbox.
 *
 * A pending older update loses the fields this one replaces — the plan and the
 * summary are always replaced whole — and is superseded outright when that
 * leaves it nothing to send. Added and removed URLs are never dropped: each is
 * a change someone wanted, not a state.
 * @param tx - The caller's transaction.
 * @param agentSessionId - The session.
 * @param input - The update.
 * @param options - The row's client id, when the caller has one.
 * @returns The new row.
 * @throws {OutboxValidationError} When Linear would refuse it.
 */
export async function enqueueSessionUpdate(
  tx: TxHandle,
  agentSessionId: number,
  input: SessionUpdateInput,
  options: { clientActivityId?: string } = {},
): Promise<AgentActivity> {
  validateSessionUpdate(input);
  const seq = await nextSeq(tx, agentSessionId);

  const replaced = (["plan", "summary"] as const).filter(
    (key) => input[key] !== undefined,
  );
  if (replaced.length > 0) {
    const older = await tx
      .select()
      .from(agentActivities)
      .where(
        and(
          eq(agentActivities.agentSessionId, agentSessionId),
          eq(agentActivities.kind, "session_update"),
          eq(agentActivities.deliveryStatus, "pending"),
        ),
      );
    for (const row of older) {
      const remaining = { ...row.content };
      for (const key of replaced) delete remaining[key];
      if (Object.keys(remaining).length === Object.keys(row.content).length) {
        continue;
      }
      await tx
        .update(agentActivities)
        .set(
          Object.keys(remaining).length === 0
            ? { deliveryStatus: "superseded" }
            : { content: remaining },
        )
        .where(eq(agentActivities.id, row.id));
    }
  }

  const content = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  );
  const [row] = await tx
    .insert(agentActivities)
    .values({
      agentSessionId,
      seq,
      direction: "outbound",
      kind: "session_update",
      contentType: null,
      content,
      clientActivityId: options.clientActivityId ?? crypto.randomUUID(),
      priority: "normal",
      deliveryStatus: "pending",
    })
    .returning();
  return row;
}

/** A person's prompt (and its signal) from a `prompted` webhook. */
export interface InboundPrompt {
  externalActivityId: string;
  body: string;
  signal: ActivitySignal | null;
  signalMetadata: Record<string, unknown> | null;
  externalSourceCommentId: string | null;
  externalUserId: string | null;
}

/**
 * Record a person's prompt in the session's sequence, once: a second call with
 * the same Linear activity id returns the row already recorded.
 * @param tx - The caller's transaction.
 * @param agentSessionId - The session.
 * @param prompt - The prompt.
 * @returns The row, and whether this call wrote it.
 */
export async function recordInboundPrompt(
  tx: TxHandle,
  agentSessionId: number,
  prompt: InboundPrompt,
): Promise<{ row: AgentActivity; created: boolean }> {
  const seq = await nextSeq(tx, agentSessionId);
  const [existing] = await tx
    .select()
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.agentSessionId, agentSessionId),
        eq(agentActivities.direction, "inbound"),
        eq(agentActivities.externalActivityId, prompt.externalActivityId),
      ),
    );
  if (existing) return { row: existing, created: false };

  const [row] = await tx
    .insert(agentActivities)
    .values({
      agentSessionId,
      seq,
      direction: "inbound",
      kind: "activity",
      contentType: "prompt",
      content: { type: "prompt", body: prompt.body },
      signal: prompt.signal,
      signalMetadata: prompt.signalMetadata,
      clientActivityId: crypto.randomUUID(),
      externalActivityId: prompt.externalActivityId,
      externalSourceCommentId: prompt.externalSourceCommentId,
      externalUserId: prompt.externalUserId,
      deliveryStatus: "received",
    })
    .returning();
  return { row, created: true };
}

/**
 * Mark every pending outbound row of some sessions `failed` — the integration
 * they would be sent as can no longer act.
 * @param db - A transaction or the shared handle.
 * @param where - Which sessions: one session, or every session of an integration.
 * @param reason - The `lastError` to record.
 * @returns How many rows were failed.
 */
export async function failPending(
  db: TxHandle | typeof api.db.db,
  where: { agentSessionId: number } | { integrationId: number },
  reason: string,
): Promise<number> {
  const sessions =
    "agentSessionId" in where
      ? sql`${agentActivities.agentSessionId} = ${where.agentSessionId}`
      : sql`${agentActivities.agentSessionId} IN (SELECT ${agentSessions.id} FROM ${agentSessions} WHERE ${agentSessions.integrationId} = ${where.integrationId})`;
  const failed = await db
    .update(agentActivities)
    .set({ deliveryStatus: "failed", lastError: reason })
    .where(
      and(
        eq(agentActivities.direction, "outbound"),
        eq(agentActivities.deliveryStatus, "pending"),
        sessions,
      ),
    )
    .returning({ id: agentActivities.id });
  return failed.length;
}

/**
 * Enqueue `activities:deliver` for each session — the accelerant after a
 * commit. A lost enqueue costs at most the `activities:deliver-due` clock's
 * interval.
 * @param agentSessionIds - The sessions with something new to send.
 */
export async function scheduleDelivery(
  agentSessionIds: Iterable<number>,
): Promise<void> {
  for (const agentSessionId of new Set(agentSessionIds)) {
    await api.actions.enqueue("activities:deliver", { agentSessionId });
  }
}

/** What one {@link deliverSession} run did. */
export interface DeliveryRun {
  /** False when another process held the session's lease. */
  ran: boolean;
  sent: number;
  failed: number;
  /** True when the head row was left waiting (backoff, budget, rate limit). */
  deferred: boolean;
}

/** How many rows one run sends before yielding to the next job. */
const MAX_ROWS_PER_RUN = 100;

/** The first retry waits this long; each further one doubles it. */
const BACKOFF_BASE_MS = 1000;

/** No retry waits longer than this. */
const BACKOFF_CAP_MS = 5 * 60 * 1000;

/**
 * The Redis key of a session's delivery lease.
 * @param agentSessionId - The session.
 * @returns The key.
 */
export function deliveryLockKey(agentSessionId: number): string {
  return `activities:deliver:${agentSessionId}`;
}

/**
 * Whether a GraphQL failure is Linear saying the client id was already used —
 * a retry of a send that landed. That is the success the client id exists for.
 * @param e - The error.
 * @returns True for a duplicate id.
 */
export function isDuplicateActivityError(e: LinearGraphQLError): boolean {
  return e.errors.some(
    (entry) =>
      entry.extensions?.code === "CONFLICT" ||
      /already exists/i.test(entry.message),
  );
}

/**
 * Send one session's pending rows, oldest `seq` first, until none is due.
 *
 * Holds the session's lease for the whole run, so one session is never sent
 * from two processes at once and order cannot invert; different sessions run
 * in parallel. The head row decides: if it must wait — a backoff, an empty
 * bucket, a rate limit — everything behind it waits too.
 *
 * | Outcome | Row | Then |
 * |---|---|---|
 * | sent, or Linear says the id exists | `sent`; the mirror takes the status, plan, summary, or links it implies | next row |
 * | `RATELIMITED` | waits for Linear's reset; no attempt counted | stop |
 * | Linear unreachable or 5xx | attempt counted; exponential backoff from 1 s to 5 min; `failed` after the last attempt | stop |
 * | any other GraphQL error (a validation error: our bug) | `failed` at once, logged | next row |
 * | integration revoked or in error | every pending row of the session `failed` | stop |
 * @param agentSessionId - The session.
 * @returns What was done.
 */
export async function deliverSession(
  agentSessionId: number,
): Promise<DeliveryRun> {
  const run = await deliverRows(agentSessionId);
  // A sent or failed row changed what the dashboard shows: the transcript,
  // and the status, plan, or links the mirror took from it.
  if (run.sent + run.failed > 0) await broadcastSessionActivity(agentSessionId);
  return run;
}

/**
 * {@link deliverSession}'s loop, without the dashboard frame.
 * @param agentSessionId - The session.
 * @returns What was done.
 */
async function deliverRows(agentSessionId: number): Promise<DeliveryRun> {
  const run: DeliveryRun = { ran: false, sent: 0, failed: 0, deferred: false };
  const key = deliveryLockKey(agentSessionId);
  // One row can take a refresh and two attempts, each up to the request
  // deadline. A run starts no row after a third of the lease, so the lease
  // cannot lapse mid-send and let a second sender in behind it.
  const leaseMs = 6 * config.linear.requestTimeoutMs;
  const lease = await acquireLock(key, leaseMs);
  if (!lease) return run;
  run.ran = true;
  const started = Date.now();

  try {
    for (let i = 0; i < MAX_ROWS_PER_RUN; i++) {
      if (Date.now() - started > leaseMs / 3) {
        // The clock picks the rest up within a second.
        run.deferred = true;
        return run;
      }
      const [joined] = await api.db.db
        .select({ session: agentSessions, integration: integrations })
        .from(agentSessions)
        .innerJoin(
          integrations,
          eq(integrations.id, agentSessions.integrationId),
        )
        .where(eq(agentSessions.id, agentSessionId));
      if (!joined) return run;

      const [head] = await api.db.db
        .select()
        .from(agentActivities)
        .where(
          and(
            eq(agentActivities.agentSessionId, agentSessionId),
            eq(agentActivities.direction, "outbound"),
            eq(agentActivities.deliveryStatus, "pending"),
          ),
        )
        .orderBy(asc(agentActivities.seq))
        .limit(1);
      if (!head) return run;
      if (head.nextAttemptAt.getTime() > Date.now()) {
        run.deferred = true;
        return run;
      }

      if (joined.integration.status !== "active") {
        run.failed += await failPending(
          api.db.db,
          { agentSessionId },
          "integration unavailable",
        );
        return run;
      }

      const take = await takeLinearToken(joined.integration.id, head.priority);
      if (!take.granted) {
        await defer(head, Date.now() + take.waitMs, false, null);
        run.deferred = true;
        return run;
      }

      const outcome = await send(joined.integration, joined.session, head);
      if (outcome === "sent") run.sent++;
      else if (outcome === "failed") run.failed++;
      else if (outcome === "integration") {
        run.failed += await failPending(
          api.db.db,
          { agentSessionId },
          "integration unavailable",
        );
        return run;
      } else {
        run.deferred = true;
        return run;
      }
    }
    return run;
  } finally {
    await releaseLock(key, lease);
  }
}

/**
 * Send one row and record what happened.
 * @param integration - The integration to act as.
 * @param session - The session.
 * @param row - The head row.
 * @returns `sent`, `failed` (this row only), `deferred`, or `integration`
 *   (the integration can no longer act).
 */
async function send(
  integration: Integration,
  session: AgentSession,
  row: AgentActivity,
): Promise<"sent" | "failed" | "deferred" | "integration"> {
  const operation =
    row.kind === "activity"
      ? CreateAgentActivity.name
      : UpdateAgentSession.name;
  try {
    if (row.kind === "activity") {
      await linearRequest(
        integration,
        CreateAgentActivity,
        {
          input: {
            id: row.clientActivityId,
            agentSessionId: session.externalSessionId,
            content: row.content,
            ...(row.ephemeral ? { ephemeral: true } : {}),
            ...(row.signal ? { signal: row.signal } : {}),
            ...(row.signalMetadata
              ? { signalMetadata: row.signalMetadata }
              : {}),
          },
        },
        { idempotent: true },
      );
    } else {
      // Safe to send twice without a client id: every field sets a state
      // rather than adding to one — the plan and summary replace whole, and
      // added and removed links are keyed by their URL.
      await linearRequest(
        integration,
        UpdateAgentSession,
        {
          id: session.externalSessionId,
          input: row.content as LinearAgentSessionUpdateInput,
        },
        { idempotent: true },
      );
    }
    await markSent(row);
    return "sent";
  } catch (e) {
    if (
      e instanceof LinearGraphQLError &&
      isDuplicateActivityError(e) &&
      row.kind === "activity"
    ) {
      await markSent(row);
      return "sent";
    }
    if (e instanceof LinearRateLimitedError) {
      await defer(row, e.resetAt ?? Date.now() + 60_000, false, e.message);
      return "deferred";
    }
    if (e instanceof LinearIntegrationUnavailableError) {
      return "integration";
    }
    if (e instanceof LinearGraphQLError) {
      api.logger.error("Linear refused an outbound activity", {
        operation,
        agentSessionId: session.id,
        activityId: row.id,
        error: e.message,
      });
      await api.db.db
        .update(agentActivities)
        .set({
          deliveryStatus: "failed",
          attempts: row.attempts + 1,
          lastError: e.message,
        })
        .where(eq(agentActivities.id, row.id));
      return "failed";
    }
    const message = e instanceof Error ? e.message : String(e);
    const attempts = row.attempts + 1;
    if (attempts >= config.linear.deliverMaxAttempts) {
      api.logger.warn("an outbound activity ran out of attempts", {
        operation,
        agentSessionId: session.id,
        activityId: row.id,
        error: message,
      });
      await api.db.db
        .update(agentActivities)
        .set({ deliveryStatus: "failed", attempts, lastError: message })
        .where(eq(agentActivities.id, row.id));
      return "failed";
    }
    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** (attempts - 1),
      BACKOFF_CAP_MS,
    );
    await defer(row, Date.now() + backoff, true, message);
    return "deferred";
  }
}

/**
 * Push a row's next attempt out.
 * @param row - The row.
 * @param at - When it may be tried again, epoch ms.
 * @param countAttempt - Whether this was a failed attempt (a budget wait is not).
 * @param error - What to record, if anything went wrong.
 */
async function defer(
  row: AgentActivity,
  at: number,
  countAttempt: boolean,
  error: string | null,
): Promise<void> {
  await api.db.db
    .update(agentActivities)
    .set({
      nextAttemptAt: new Date(at),
      ...(countAttempt ? { attempts: row.attempts + 1 } : {}),
      ...(error ? { lastError: error } : {}),
    })
    .where(
      and(
        eq(agentActivities.id, row.id),
        eq(agentActivities.deliveryStatus, "pending"),
      ),
    );
}

/**
 * Record a sent row and bring the mirror up to what it implies: the status an
 * activity of its type gives the session in Linear, or the plan, summary, and
 * links a session update set. One transaction, under the session's lock.
 * @param row - The row Linear accepted.
 */
async function markSent(row: AgentActivity): Promise<void> {
  await api.db.db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, row.agentSessionId))
      .for("update");
    // Sent is the truth even if a later enqueue superseded the row meanwhile.
    await tx
      .update(agentActivities)
      .set({
        deliveryStatus: "sent",
        sentAt: new Date(),
        attempts: row.attempts + 1,
        externalActivityId:
          row.kind === "activity" ? row.clientActivityId : null,
        lastError: null,
      })
      .where(eq(agentActivities.id, row.id));
    if (!session) return;

    if (row.kind === "activity") {
      const implied = statusImpliedBy(row.contentType as ActivityContentType);
      if (implied) {
        await tx
          .update(agentSessions)
          .set(statusColumns(implied))
          .where(eq(agentSessions.id, session.id));
      }
      return;
    }

    const update = row.content as SessionUpdateInput;
    let externalUrls = session.externalUrls;
    if (update.removedExternalUrls) {
      const removed = new Set(update.removedExternalUrls);
      externalUrls = externalUrls.filter((link) => !removed.has(link.url));
    }
    for (const link of update.addedExternalUrls ?? []) {
      externalUrls = [...externalUrls.filter((l) => l.url !== link.url), link];
    }
    await tx
      .update(agentSessions)
      .set({
        externalUrls,
        ...(update.plan !== undefined ? { plan: update.plan } : {}),
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
      })
      .where(eq(agentSessions.id, session.id));
  });
}

/**
 * Sessions with a row due now: what the `activities:deliver-due` clock sends.
 * @param limit - The most sessions to return.
 * @returns Session ids.
 */
export async function sessionsWithDueRows(limit = 200): Promise<number[]> {
  const rows = await api.db.db
    .selectDistinct({ agentSessionId: agentActivities.agentSessionId })
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.deliveryStatus, "pending"),
        lte(agentActivities.nextAttemptAt, new Date()),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.agentSessionId);
}
