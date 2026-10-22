import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { api } from "keryx";
import { agentActivities } from "../schema/agent_activities";
import {
  type AgentSession,
  agentSessions,
  type DispatchMode,
  type IssueSnapshot,
} from "../schema/agent_sessions";
import type { Integration } from "../schema/integrations";
import { runners } from "../schema/runners";
import {
  type WorkItem,
  type WorkItemOutcome,
  type WorkItemReviewPayload,
  type WorkItemStatus,
  workItems,
} from "../schema/work_items";
import { enqueueActivity } from "./ActivityOutboxOps";
import { writeAuditLog } from "./AuditOps";
import {
  type ToolScope,
  targetRefused,
  toolInputRefused,
} from "./DaemonScopeOps";
import { resolveIssuer } from "./IdentityOps";
import { LinearBudgetExhaustedError } from "./LinearBucketOps";
import { LinearGraphQLError, LinearRateLimitedError } from "./LinearOps";
import {
  CreateAgentSessionOnIssue,
  GetIssue,
  type LinearIssueScope,
  UpdateIssue,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";
import { getManagerSettings, getRoutingSettings } from "./ProjectSettingsOps";
import {
  applyEffects,
  lockSession,
  noEffects,
  type WorkEffects,
} from "./WorkItemOps";
import { snapshotFromIssue } from "./WorkRouteOps";

/**
 * A manager session handing work to workers, and their results coming back.
 *
 * **Dispatch** (`daemon:dispatch`, the manager's `hypotenuse_dispatch` tool):
 *
 * 1. Under the manager session's row lock, every guard below; then a slot is
 *    reserved in Redis — the issue's **intent** and the manager's
 *    **in-flight** set — before the lock is released, so two dispatches
 *    racing from one turn cannot both pass the cap at `cap - 1`.
 * 2. After commit, Linear: `agentSessionCreateOnIssue`, then `issueUpdate`
 *    setting the delegate (never the assignee) when it is not already the app.
 * 3. {@link completeDispatch}: the child session row (role `worker`, forced),
 *    its work item, the thoughts that make it visible — run by whichever of
 *    the dispatch and Linear's `created` webhook for the new session gets
 *    there first. The second finds the work done.
 *
 * Every failure leaves either nothing, or a Linear session Hypotenuse can
 * recognise by its intent — never a work item for a session that does not
 * exist.
 *
 * | Guard | Refusal |
 * |---|---|
 * | the session is a manager's | 403 |
 * | the target is one the manager manages, on a team the integration may read | 403 |
 * | not the manager's own issue | 406 |
 * | `new`: no dispatch of this issue under way, by this manager or anyone | 406 |
 * | `changes`: a finished child of this manager on the issue, still delegated | 406 |
 * | `changes`: the child's `reviewRound` below `routing.maxReviewRounds` | 406 |
 * | under way children (and reserved slots) below `manager.maxParallelDispatch` | 406 |
 *
 * **Review**: a child's turn that ends (completed, failed, or expired) puts a
 * `review` turn on the parent manager session — see {@link enqueueReviewIfChild}.
 */

/** How long a dispatch's intent outlives the call that wrote it. */
export const DISPATCH_INTENT_TTL_SECONDS = 600;

/**
 * The cancel reasons after which a manager session is not woken for a
 * review: a person's stop, and every disengagement in `DISENGAGED_CANCEL_REASONS`
 * (spelled out here because that module imports this one).
 */
const PARENT_DISENGAGED_REASONS: ReadonlySet<string> = new Set([
  "delegate_removed",
  "issue_closed",
  "integration_revoked",
  "stop",
]);

/**
 * What a dispatch intends, kept in Redis between reserving its slot and
 * recording its child, so the `created` webhook for the session it starts
 * can finish the job if it arrives first.
 */
export interface DispatchIntent {
  managerSessionId: number;
  projectId: number;
  integrationId: number;
  externalIssueId: string;
  mode: DispatchMode;
  /** 0 for a new dispatch; the child's round + 1 for changes. */
  reviewRound: number;
  instructions: string | null;
  agentPreference: string | null;
  /** The manager session's creator, so the worker prefers their runners. */
  preferredUserId: number | null;
  parentIssueIdentifier: string | null;
  parentIssueUrl: string | null;
  /** The Linear session, once known (a `changes` dispatch knows it at once). */
  externalSessionId: string | null;
}

/**
 * The intent key for an issue.
 * @param integrationId - The integration.
 * @param externalIssueId - The issue's Linear id.
 * @returns The Redis key.
 */
export function dispatchIntentKey(
  integrationId: number,
  externalIssueId: string,
): string {
  return `dispatch:intent:${integrationId}:${externalIssueId}`;
}

/**
 * The key of a manager session's in-flight dispatches: issue id → epoch ms.
 * @param managerSessionId - The manager session.
 * @returns The Redis key.
 */
export function dispatchInflightKey(managerSessionId: number): string {
  return `dispatch:inflight:${managerSessionId}`;
}

/**
 * Write a dispatch's intent and reserve its slot.
 * @param intent - The intent.
 */
export async function writeDispatchIntent(
  intent: DispatchIntent,
): Promise<void> {
  const redis = api.redis.redis;
  const inflight = dispatchInflightKey(intent.managerSessionId);
  await redis
    .multi()
    .set(
      dispatchIntentKey(intent.integrationId, intent.externalIssueId),
      JSON.stringify(intent),
      "EX",
      DISPATCH_INTENT_TTL_SECONDS,
    )
    .hset(inflight, intent.externalIssueId, String(Date.now()))
    .expire(inflight, DISPATCH_INTENT_TTL_SECONDS)
    .exec();
}

/**
 * Read an issue's dispatch intent.
 * @param integrationId - The integration.
 * @param externalIssueId - The issue.
 * @returns The intent, or null.
 */
export async function readDispatchIntent(
  integrationId: number,
  externalIssueId: string,
): Promise<DispatchIntent | null> {
  const raw = await api.redis.redis.get(
    dispatchIntentKey(integrationId, externalIssueId),
  );
  return raw ? (JSON.parse(raw) as DispatchIntent) : null;
}

/**
 * Drop a dispatch's intent and release its reserved slot.
 * @param intent - The intent.
 */
export async function clearDispatchIntent(
  intent: Pick<
    DispatchIntent,
    "integrationId" | "externalIssueId" | "managerSessionId"
  >,
): Promise<void> {
  await api.redis.redis
    .multi()
    .del(dispatchIntentKey(intent.integrationId, intent.externalIssueId))
    .hdel(dispatchInflightKey(intent.managerSessionId), intent.externalIssueId)
    .exec();
}

/**
 * The issues a manager session has dispatches in flight for, younger than
 * the intent TTL (a crashed call's reservation lapses with its intent).
 * @param managerSessionId - The manager session.
 * @returns The issues' Linear ids.
 */
async function inflightIssues(managerSessionId: number): Promise<string[]> {
  const all = await api.redis.redis.hgetall(
    dispatchInflightKey(managerSessionId),
  );
  const cutoff = Date.now() - DISPATCH_INTENT_TTL_SECONDS * 1000;
  return Object.entries(all)
    .filter(([, at]) => Number(at) > cutoff)
    .map(([issue]) => issue);
}

/** SQL: the session has a turn that has not ended. */
const hasLiveWork = sql`EXISTS (SELECT 1 FROM work_items wi WHERE wi.agent_session_id = ${agentSessions.id} AND wi.status NOT IN ('completed', 'failed', 'cancelled', 'expired'))`;

/**
 * A manager session's children, newest first, with whether each has a turn
 * under way.
 * @param tx - The transaction.
 * @param managerSessionId - The manager session.
 * @returns The children.
 */
export async function childSessions(
  tx: TxHandle | typeof api.db.db,
  managerSessionId: number,
): Promise<(AgentSession & { live: boolean })[]> {
  const rows = await tx
    .select({ session: agentSessions, live: sql<boolean>`${hasLiveWork}` })
    .from(agentSessions)
    .where(eq(agentSessions.parentAgentSessionId, managerSessionId))
    .orderBy(desc(agentSessions.id));
  return rows.map((r) => ({ ...r.session, live: Boolean(r.live) }));
}

/** What the guards decided. */
export interface DispatchPlan {
  mode: DispatchMode;
  reviewRound: number;
  /** For `changes`: the worker session sent back. */
  child: AgentSession | null;
}

/**
 * Every guard in the table above, under the manager session's lock.
 * @param tx - The transaction (the manager session is locked).
 * @param manager - The manager session.
 * @param target - The issue to dispatch.
 * @param mode - `new` or `changes`.
 * @returns What to do.
 * @throws {TypedError} 403 or 406, with a sentence the model can act on.
 */
export async function assertCanDispatch(
  tx: TxHandle,
  manager: AgentSession,
  target: Pick<LinearIssueScope, "id" | "identifier">,
  mode: DispatchMode,
): Promise<DispatchPlan> {
  if (manager.role !== "manager") {
    throw targetRefused(
      "Only a manager session may dispatch; a worker cannot hand work on.",
    );
  }
  if (target.id === manager.externalIssueId) {
    throw toolInputRefused(
      `${target.identifier} is the issue you are working on; dispatch a sub-issue or another issue instead.`,
    );
  }
  const children = await childSessions(tx, manager.id);
  const inflight = await inflightIssues(manager.id);
  const live = children.filter((c) => c.live);
  const onIssue = children.filter((c) => c.externalIssueId === target.id);

  let plan: DispatchPlan;
  if (mode === "new") {
    if (
      onIssue.some((c) => c.live) ||
      inflight.includes(target.id) ||
      (await otherLiveSession(tx, manager, target.id))
    ) {
      throw toolInputRefused(
        `${target.identifier} is already dispatched or has a Hypotenuse session under way; wait for its result before dispatching it again.`,
      );
    }
    plan = { mode, reviewRound: 0, child: null };
  } else {
    const child = onIssue[0];
    if (!child) {
      throw toolInputRefused(
        `You have not dispatched ${target.identifier}; use mode "new" to start a worker on it.`,
      );
    }
    if (child.live || inflight.includes(target.id)) {
      throw toolInputRefused(
        `The worker on ${target.identifier} is still working; review its result before requesting changes.`,
      );
    }
    if (child.delegateRemovedAt) {
      throw toolInputRefused(
        `A person removed Hypotenuse from ${target.identifier}; it cannot be sent back. Ask them with linear_ask_user.`,
      );
    }
    const { maxReviewRounds } = await getRoutingSettings(tx, manager.projectId);
    if (child.reviewRound >= maxReviewRounds) {
      throw toolInputRefused(
        `Review round limit reached for ${target.identifier} (${maxReviewRounds}) — hand this to a person: ask the session's creator with linear_ask_user what to do about what is still wrong.`,
      );
    }
    plan = { mode, reviewRound: child.reviewRound + 1, child };
  }

  const { maxParallelDispatch } = await getManagerSettings(
    tx,
    manager.projectId,
  );
  const underWay = new Set([
    ...live.map((c) => c.externalIssueId),
    ...inflight,
  ]);
  if (underWay.size >= maxParallelDispatch) {
    throw toolInputRefused(
      `You already have ${underWay.size} dispatched issue${underWay.size === 1 ? "" : "s"} under way, the most this project allows at once (${maxParallelDispatch}). Wait for a review turn before dispatching more.`,
    );
  }
  return plan;
}

/**
 * Whether a session other than this manager's children has a turn under way
 * on the issue — a person's own session there, which a delegation would join.
 * @param tx - The transaction.
 * @param manager - The manager session.
 * @param externalIssueId - The issue.
 * @returns True when one does.
 */
async function otherLiveSession(
  tx: TxHandle,
  manager: AgentSession,
  externalIssueId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.integrationId, manager.integrationId),
        eq(agentSessions.externalIssueId, externalIssueId),
        ne(agentSessions.id, manager.id),
        hasLiveWork,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** What one dispatch did, as the tool answers it. */
export interface DispatchResult {
  agentSessionId: number;
  externalSessionId: string;
  externalSessionUrl: string | null;
  issueIdentifier: string;
  mode: DispatchMode;
  reviewRound: number;
}

/**
 * The thought a dispatched worker session opens with.
 * @param parentIssueUrl - The planning issue.
 * @returns The body.
 */
export function dispatchedThought(parentIssueUrl: string | null): string {
  return parentIssueUrl
    ? `Dispatched by the planning session on ${parentIssueUrl}.`
    : "Dispatched by a planning session.";
}

/**
 * The thought a worker session shows when the manager sends it back.
 * @param instructions - What to change.
 * @returns The body.
 */
export function changesThought(instructions: string | null): string {
  return instructions
    ? `The planning agent requested changes: ${instructions}`
    : "The planning agent requested changes.";
}

/**
 * Run one dispatch: guard and reserve, call Linear, record the child.
 * @param ts - The manager's tool call.
 * @param input - What the tool was given.
 * @returns What was dispatched.
 */
export async function runDispatch(
  ts: ToolScope,
  input: {
    issue: string;
    instructions?: string;
    agentPreference?: string;
    mode?: DispatchMode;
  },
): Promise<DispatchResult> {
  const mode = input.mode ?? "new";
  const target = await ts.issue(input.issue);
  await ts.assertManaged(target);
  ts.assertReadable(target.team, target.identifier);
  const integration = ts.scope.integration;

  const reserved = await api.db.db.transaction(async (tx) => {
    const manager = await lockSession(tx, ts.session.id);
    const plan = await assertCanDispatch(tx, manager, target, mode);
    const intent: DispatchIntent = {
      managerSessionId: manager.id,
      projectId: manager.projectId,
      integrationId: integration.id,
      externalIssueId: target.id,
      mode,
      reviewRound: plan.reviewRound,
      instructions: input.instructions?.trim() || null,
      agentPreference: input.agentPreference?.trim() || null,
      preferredUserId: await resolveIssuer(tx, manager),
      parentIssueIdentifier: manager.issueIdentifier,
      parentIssueUrl: manager.issueUrl,
      externalSessionId: plan.child?.externalSessionId ?? null,
    };
    // Written before the lock is released: the next dispatch's guards count it.
    await writeDispatchIntent(intent);
    return { intent, plan };
  });
  const { intent, plan } = reserved;

  // Once Linear may have a session, the intent (and the slot) stays until
  // it lapses: the `created` webhook for that session finishes the dispatch
  // if this call cannot, and a retry meanwhile is refused rather than
  // starting a second worker.
  let started = false;
  try {
    let child: { externalSessionId: string; url: string | null } | null = null;
    let snapshot: IssueSnapshot | null = null;
    if (mode === "new") {
      const created = await ts.linear(
        CreateAgentSessionOnIssue,
        { input: { issueId: target.id } },
        "write",
      );
      const session = created.agentSessionCreateOnIssue.agentSession;
      started = true;
      child = { externalSessionId: session.id, url: session.url ?? null };
      intent.externalSessionId = session.id;
      await api.redis.redis.set(
        dispatchIntentKey(integration.id, target.id),
        JSON.stringify(intent),
        "EX",
        DISPATCH_INTENT_TTL_SECONDS,
      );
      snapshot = await delegateToApp(ts, integration, target.id);
    }

    const result = await api.db.db.transaction(async (tx) => {
      const row = plan.child
        ? await lockSession(tx, plan.child.id)
        : await upsertDispatchedSession(tx, integration, {
            externalSessionId: child!.externalSessionId,
            externalUrl: child!.url,
            snapshot: snapshot!,
            externalTeamId: target.team.id,
          });
      const effects = await completeDispatch(tx, intent, row);
      await writeAuditLog(tx, {
        userId: await runnerOwner(tx, ts.scope.item.runnerId),
        projectId: row.projectId,
        action: "agent:dispatch",
        targetType: "agent_session",
        targetPath: String(row.id),
        metadata: {
          managerSessionId: intent.managerSessionId,
          issue: target.identifier,
          mode,
          reviewRound: intent.reviewRound,
          runnerId: ts.scope.item.runnerId,
        },
        after: {
          agentSessionId: row.id,
          externalSessionId: row.externalSessionId,
          parentAgentSessionId: intent.managerSessionId,
        },
      });
      return { row, effects };
    });
    await clearDispatchIntent(intent);
    await applyEffects(result.effects);
    await ts.recordWrite(target.identifier, target.id);
    return {
      agentSessionId: result.row.id,
      externalSessionId: result.row.externalSessionId,
      externalSessionUrl: result.row.externalUrl,
      issueIdentifier: target.identifier,
      mode,
      reviewRound: intent.reviewRound,
    };
  } catch (e) {
    if (!started && refusedBeforeActing(e)) await clearDispatchIntent(intent);
    throw e;
  }
}

/**
 * Whether a failure means Linear did not act: it refused the request, or the
 * request was never sent. A lost response or a timeout may hide a session
 * Linear did create.
 * @param e - What the Linear call threw.
 * @returns True when nothing was created.
 */
function refusedBeforeActing(e: unknown): boolean {
  return (
    e instanceof LinearGraphQLError ||
    e instanceof LinearRateLimitedError ||
    e instanceof LinearBudgetExhaustedError
  );
}

/**
 * Make the app the issue's delegate (never its assignee), when it is not
 * already, and read the issue for the child's snapshot.
 * @param ts - The tool call.
 * @param integration - The integration.
 * @param issueId - The issue.
 * @returns The issue's snapshot.
 */
async function delegateToApp(
  ts: ToolScope,
  integration: Integration,
  issueId: string,
): Promise<IssueSnapshot> {
  const { issue } = await ts.linear(GetIssue, { id: issueId }, "read");
  if (issue.delegate?.id === integration.externalAppUserId) {
    return snapshotFromIssue(issue);
  }
  const updated = await ts.linear(
    UpdateIssue,
    { id: issueId, input: { delegateId: integration.externalAppUserId } },
    "write",
  );
  return snapshotFromIssue(updated.issueUpdate.issue);
}

/**
 * The person whose runner made a call.
 * @param tx - The transaction.
 * @param runnerId - The runner.
 * @returns Its owner's user id, or null.
 */
async function runnerOwner(
  tx: TxHandle,
  runnerId: number | null,
): Promise<number | null> {
  if (runnerId === null) return null;
  const [row] = await tx
    .select({ userId: runners.userId })
    .from(runners)
    .where(eq(runners.id, runnerId));
  return row?.userId ?? null;
}

/**
 * Insert (or find, and lock) the mirror row of a session a dispatch started.
 * Keyed by the Linear session id, so Linear's `created` for it — before or
 * after — converges on the same row.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param session - What Linear answered and the issue as read.
 * @returns The row, locked.
 */
async function upsertDispatchedSession(
  tx: TxHandle,
  integration: Integration,
  session: {
    externalSessionId: string;
    externalUrl: string | null;
    snapshot: IssueSnapshot;
    externalTeamId: string;
  },
): Promise<AgentSession> {
  const { snapshot } = session;
  await tx
    .insert(agentSessions)
    .values({
      projectId: integration.projectId,
      type: integration.type,
      integrationId: integration.id,
      externalSessionId: session.externalSessionId,
      externalUrl: session.externalUrl,
      externalIssueId: snapshot.id,
      issueIdentifier: snapshot.identifier,
      issueTitle: snapshot.title,
      issueUrl: snapshot.url,
      externalTeamId: session.externalTeamId,
      teamKey: snapshot.teamKey,
      origin: "proactive",
      issueSnapshot: snapshot,
    })
    .onConflictDoNothing({
      target: [agentSessions.type, agentSessions.externalSessionId],
    });
  const [row] = await tx
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.type, integration.type),
        eq(agentSessions.externalSessionId, session.externalSessionId),
      ),
    )
    .for("update");
  if (!row.issueSnapshot) {
    const [updated] = await tx
      .update(agentSessions)
      .set({
        issueSnapshot: snapshot,
        externalUrl: row.externalUrl ?? session.externalUrl,
      })
      .where(eq(agentSessions.id, row.id))
      .returning();
    return updated;
  }
  return row;
}

/**
 * Record a dispatch on its child session: the role, parent, and round; the
 * worker's turn; and the thoughts that make it visible on both sessions.
 * Locks the child (the caller has) and then its manager — the order every
 * dispatch keeps; ending a child's turn takes the child and only reads or
 * inserts beside the manager.
 * Idempotent — whichever of the dispatch and Linear's `created` webhook runs
 * it second finds the work already queued and does nothing.
 * @param tx - The transaction (the child session is locked).
 * @param intent - The dispatch.
 * @param child - The child session, locked.
 * @returns The effects to apply after commit.
 */
export async function completeDispatch(
  tx: TxHandle,
  intent: DispatchIntent,
  child: AgentSession,
): Promise<WorkEffects> {
  const effects = noEffects();
  // The manager next, before anything writes the child's parent column: that
  // write takes a key-share lock on the manager's row, and two dispatches
  // holding one each would deadlock upgrading it for the manager's outbox.
  await lockSession(tx, intent.managerSessionId);
  const [live] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, child.id),
        sql`${workItems.status} NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
      ),
    )
    .limit(1);
  if (live) return effects;
  if (intent.mode === "new") {
    // Linear may have started a second session for the delegation: one child
    // per issue under way, whichever session it is on.
    const [sibling] = await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.parentAgentSessionId, intent.managerSessionId),
          eq(agentSessions.externalIssueId, intent.externalIssueId),
          ne(agentSessions.id, child.id),
          hasLiveWork,
        ),
      )
      .limit(1);
    if (sibling) return effects;
  }

  const [session] = await tx
    .update(agentSessions)
    .set({
      role: "worker",
      parentAgentSessionId: intent.managerSessionId,
      dispatchMode: intent.mode,
      reviewRound: intent.reviewRound,
      ...(intent.mode === "new" ? { origin: "proactive" as const } : {}),
    })
    .where(eq(agentSessions.id, child.id))
    .returning();

  const changes = intent.mode === "changes";
  const prepared = changes && session.repository !== null;
  await tx.insert(workItems).values({
    projectId: session.projectId,
    agentSessionId: session.id,
    kind: changes ? "prompt" : "dispatch",
    role: "worker",
    repository: prepared ? session.repository : null,
    repositoryResolved: prepared,
    prompt: changes ? [] : null,
    payload: {
      dispatch: {
        mode: intent.mode,
        reviewRound: intent.reviewRound,
        instructions: intent.instructions,
        agentPreference: intent.agentPreference,
        dispatchedBy: intent.managerSessionId,
      },
    },
    preferredUserId: intent.preferredUserId,
    stickyRunnerId: session.runnerId,
  });

  await enqueueActivity(
    tx,
    session.id,
    {
      type: "thought",
      body: changes
        ? changesThought(intent.instructions)
        : dispatchedThought(intent.parentIssueUrl),
    },
    { priority: "ack" },
  );
  await enqueueActivity(tx, intent.managerSessionId, {
    type: "action",
    action: changes ? "Requested changes" : "Dispatched",
    parameter: session.issueIdentifier ?? session.externalIssueId,
    result: session.externalUrl ?? session.issueUrl ?? "",
  });
  effects.deliver.add(session.id);
  effects.deliver.add(intent.managerSessionId);
  effects.route = true;
  return effects;
}

/**
 * Linear's `created` for a session a dispatch is starting, arriving before
 * the dispatch recorded it: the session takes the intent's role and parent.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param session - The session, just mirrored.
 * @returns What was done, or null when no dispatch intends this session.
 */
export async function adoptDispatchedSession(
  tx: TxHandle,
  integration: Integration,
  session: AgentSession,
): Promise<
  { kind: "adopted"; effects: WorkEffects } | { kind: "duplicate" } | null
> {
  const intent = await readDispatchIntent(
    integration.id,
    session.externalIssueId,
  );
  if (!intent || intent.mode !== "new") return null;
  if (
    intent.externalSessionId !== null &&
    intent.externalSessionId !== session.externalSessionId
  ) {
    // A second session on the issue while its dispatch is in flight — one
    // Linear started for the delegation, say. The dispatch's own session
    // carries the work; this one is left alone rather than given a worker.
    return { kind: "duplicate" };
  }
  const locked = await lockSession(tx, session.id);
  return {
    kind: "adopted",
    effects: await completeDispatch(tx, intent, locked),
  };
}

/**
 * The body of a session's last `response` or `error`.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The body, or null.
 */
async function lastAnswer(
  tx: TxHandle,
  agentSessionId: number,
): Promise<{ type: string; body: string | null } | null> {
  const [row] = await tx
    .select({
      type: agentActivities.contentType,
      content: agentActivities.content,
    })
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.agentSessionId, agentSessionId),
        eq(agentActivities.direction, "outbound"),
        eq(agentActivities.kind, "activity"),
        inArray(agentActivities.contentType, [
          "response",
          "error",
          "elicitation",
        ]),
      ),
    )
    .orderBy(desc(agentActivities.seq))
    .limit(1);
  if (!row) return null;
  const body = (row.content as { body?: unknown }).body;
  return {
    type: row.type ?? "",
    body: typeof body === "string" ? body : null,
  };
}

/**
 * A session's plan and links as they will be once its outbox is delivered:
 * the row holds what Linear has accepted, and the turn that just ended may
 * still have updates waiting.
 * @param tx - The transaction.
 * @param session - The session.
 * @returns The plan and the external links.
 */
async function pendingSessionState(
  tx: TxHandle,
  session: AgentSession,
): Promise<Pick<AgentSession, "plan" | "externalUrls">> {
  const updates = await tx
    .select({ content: agentActivities.content })
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.agentSessionId, session.id),
        eq(agentActivities.kind, "session_update"),
        eq(agentActivities.deliveryStatus, "pending"),
      ),
    )
    .orderBy(agentActivities.seq);
  let { plan, externalUrls } = session;
  for (const { content } of updates) {
    const update = content as {
      plan?: AgentSession["plan"];
      addedExternalUrls?: AgentSession["externalUrls"];
      removedExternalUrls?: string[];
    };
    if (update.plan !== undefined) plan = update.plan;
    const removed = new Set(update.removedExternalUrls ?? []);
    externalUrls = externalUrls.filter((l) => !removed.has(l.url));
    for (const link of update.addedExternalUrls ?? []) {
      externalUrls = [...externalUrls.filter((l) => l.url !== link.url), link];
    }
  }
  return { plan, externalUrls };
}

/**
 * The review payload for a child session's finished turn: its last answer,
 * plan, and pull requests.
 * @param tx - The transaction.
 * @param child - The child session.
 * @param outcome - How the turn ended.
 * @returns The payload.
 */
export async function buildReviewPayload(
  tx: TxHandle,
  child: AgentSession,
  outcome: WorkItemReviewPayload["outcome"],
): Promise<WorkItemReviewPayload> {
  const answer = await lastAnswer(tx, child.id);
  const { plan, externalUrls } = await pendingSessionState(tx, child);
  return {
    childSessionId: child.id,
    childIssueIdentifier: child.issueIdentifier,
    childIssueUrl: child.issueUrl,
    reviewRound: child.reviewRound,
    outcome,
    finalResponse: answer?.body ?? null,
    plan,
    pullRequests: externalUrls.filter((u) => /^pull request/i.test(u.label)),
  };
}

/**
 * When a dispatched worker's turn ends, put a `review` turn on its manager
 * session, sticky to the manager's runner. Called by `finishWorkItem`, inside
 * the transaction that ends the child's turn. Nothing is queued when:
 *
 * | Case | Why |
 * |---|---|
 * | the session has no parent | it was not dispatched |
 * | the turn was cancelled | a person stopped it, or it was superseded — re-dispatching would re-engage what they stopped |
 * | the turn ended on a question | the worker waits on a person; the turn that follows the answer is reviewed |
 * | the manager session was stopped or un-delegated | nothing re-engages it without a person |
 *
 * The review's acknowledgement thought is posted when it is offered, not
 * here, so a manager mid-turn does not show "Reviewing" while busy.
 * @param tx - The transaction.
 * @param item - The child's item, ending.
 * @param status - How it ends.
 * @param outcome - What the daemon reported, if it did.
 * @returns True when a review was queued.
 */
export async function enqueueReviewIfChild(
  tx: TxHandle,
  item: WorkItem,
  status: WorkItemStatus,
  outcome: WorkItemOutcome | null | undefined,
): Promise<boolean> {
  if (status === "cancelled" || item.kind === "review") return false;
  const [child] = await tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, item.agentSessionId));
  if (!child?.parentAgentSessionId) return false;
  const answer = await lastAnswer(tx, child.id);
  if (answer?.type === "elicitation") return false;

  const [parent] = await tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, child.parentAgentSessionId));
  if (!parent || parent.delegateRemovedAt) return false;
  const [last] = await tx
    .select({ status: workItems.status, cancelReason: workItems.cancelReason })
    .from(workItems)
    .where(eq(workItems.agentSessionId, parent.id))
    .orderBy(desc(workItems.id))
    .limit(1);
  if (
    last?.status === "cancelled" &&
    last.cancelReason &&
    PARENT_DISENGAGED_REASONS.has(last.cancelReason)
  ) {
    return false;
  }

  const reported = outcome?.outcome;
  const reviewOutcome: WorkItemReviewPayload["outcome"] =
    status === "completed" && reported !== "failed" ? "completed" : "failed";
  await tx.insert(workItems).values({
    projectId: parent.projectId,
    agentSessionId: parent.id,
    kind: "review",
    role: parent.role ?? "manager",
    repository: parent.repository,
    repositoryResolved: parent.role !== null,
    payload: { review: await buildReviewPayload(tx, child, reviewOutcome) },
    preferredUserId: await resolveIssuer(tx, parent),
    stickyRunnerId: parent.runnerId,
  });
  return true;
}

/**
 * Whether a queued review is stale: its child has been sent back since (its
 * round advanced), or a newer review of the same child is waiting.
 * @param tx - The transaction.
 * @param item - The review item.
 * @returns True when it should be cancelled as superseded.
 */
export async function reviewSuperseded(
  tx: TxHandle,
  item: WorkItem,
): Promise<boolean> {
  const review =
    item.payload && "review" in item.payload ? item.payload.review : null;
  if (!review) return false;
  const [child] = await tx
    .select({ reviewRound: agentSessions.reviewRound })
    .from(agentSessions)
    .where(eq(agentSessions.id, review.childSessionId));
  if (child && child.reviewRound > review.reviewRound) return true;
  const [newer] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, item.agentSessionId),
        eq(workItems.kind, "review"),
        sql`${workItems.id} > ${item.id}`,
        sql`${workItems.status} NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
        sql`(${workItems.payload} -> 'review' ->> 'childSessionId')::int = ${review.childSessionId}`,
      ),
    )
    .limit(1);
  return Boolean(newer);
}

/**
 * The thought a manager session shows when a review turn is offered.
 * @param review - The review payload.
 * @returns The body.
 */
export function reviewingThought(review: WorkItemReviewPayload): string {
  return `Reviewing ${review.childIssueIdentifier ?? "a dispatched issue"} (round ${review.reviewRound + 1})…`;
}
