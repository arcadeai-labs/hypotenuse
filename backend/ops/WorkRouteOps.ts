import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { api, config } from "keryx";
import {
  type AgentSession,
  agentSessions,
  type IssueSnapshot,
  type RepositoryChoiceOption,
} from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import { runners } from "../schema/runners";
import { type WorkItem, workItems } from "../schema/work_items";
import { enqueueActivity } from "./ActivityOutboxOps";
import { linearRequest } from "./LinearOps";
import { acquireLock, releaseLock } from "./LockOps";
import {
  GetComment,
  GetIssue,
  IssueRepositorySuggestions,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";
import { getRoutingSettings } from "./ProjectSettingsOps";
import {
  candidateRepository,
  type EligibilityQuery,
  eligibleRunners,
  explainUnplaceable,
  listRoutingRules,
  parseRepositoryAnswer,
  type RoleDecision,
  rankRunners,
  repositoryCandidates,
  repositoryOption,
  roleThought,
  routingFacts,
  selectRole,
} from "./RoutingOps";
import {
  finishWorkItem,
  KEEPALIVE_AFTER_MS,
  lockItemWithSession,
  lockSession,
  mergeEffects,
  noEffects,
  type WorkEffects,
} from "./WorkItemOps";

/**
 * Routing's moving half: preparing a session's turns (the issue read, the
 * role and repository chosen) and placing prepared turns on runners as
 * offers. Both run in `work:route`, enqueued after anything that could make
 * work placeable and as a clock.
 *
 * Everything that calls Linear happens **outside** a transaction, and the
 * transaction that follows re-checks what it read — a turn waiting on Linear
 * must not hold a session's row lock, or every webhook for it would wait too.
 */

/** The most repositories a `select` offers. */
export const MAX_REPOSITORY_OPTIONS = 8;

/** The question a session gets when Linear is not sure which repository. */
export function repositoryQuestion(issueIdentifier: string | null): string {
  return `Which repository should I work in for ${issueIdentifier ?? "this issue"}? Pick one, or reply with its name.`;
}

/** The second question, after an answer that matched nothing. */
export const REPOSITORY_RETRY_BODY =
  "I couldn't match that to a repository I can work in. Pick one of these, or reply with its owner/name:";

/**
 * The thought that names the repository chosen.
 * @param remote - `hostname/owner/name`.
 * @returns The thought's body.
 */
export function repositoryThought(remote: string): string {
  return `Working in **${candidateRepository(remote).repositoryFullName}**.`;
}

/**
 * Read an issue from the trigger system: the facts rules and subscriptions
 * match on, and the snapshot an assignment carries.
 * @param integration - The integration to read as.
 * @param issueId - The issue.
 * @returns The snapshot.
 */
export async function fetchIssueSnapshot(
  integration: Integration,
  issueId: string,
): Promise<IssueSnapshot> {
  const { issue } = await linearRequest(
    integration,
    GetIssue,
    { id: issueId },
    { idempotent: true },
  );
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    teamKey: issue.team?.key ?? null,
    labels: issue.labels.nodes.map((l) => l.name),
    state: issue.state
      ? { name: issue.state.name, type: issue.state.type }
      : null,
    parent: issue.parent ? { id: issue.parent.id } : null,
    project: issue.project
      ? { id: issue.project.id, name: issue.project.name }
      : null,
  };
}

/**
 * What a mention said: the comment that mentioned the agent.
 * @param integration - The integration to read as.
 * @param session - The session.
 * @returns The comment's body, or null for a delegation.
 */
async function fetchMentionText(
  integration: Integration,
  session: AgentSession,
): Promise<string | null> {
  const commentId =
    session.externalSourceCommentId ?? session.externalCommentId;
  if (session.origin !== "mention" || !commentId) return null;
  const { comment } = await linearRequest(
    integration,
    GetComment,
    { id: commentId },
    { idempotent: true },
  );
  return comment.body;
}

/**
 * The snapshot a session's routing reads, or the little the webhook said.
 * @param session - The session.
 * @returns The snapshot.
 */
function snapshotOf(session: AgentSession): IssueSnapshot {
  return (
    session.issueSnapshot ?? {
      id: session.externalIssueId,
      identifier: session.issueIdentifier,
      title: session.issueTitle,
      description: null,
      url: session.issueUrl,
      teamKey: session.teamKey,
      labels: [],
      state: null,
      parent: null,
      project: null,
    }
  );
}

/** How a session's repository was decided, if it was. */
type RepositoryDecision =
  | { kind: "resolved"; repository: string | null; announce: boolean }
  | { kind: "ask"; options: RepositoryChoiceOption[] }
  | { kind: "unresolved" };

/**
 * Choose the repository for a session's first turn, in order: a rule's pin;
 * the only candidate; Linear's top suggestion at or above the project's
 * confidence; otherwise ask. The candidates are the repositories of the
 * runners eligible for this role and issue, ignoring repositories. None, and
 * a worker waits; a manager works without one.
 * @param session - The session.
 * @param integration - Its integration.
 * @param role - The role chosen.
 * @param snapshot - The issue.
 * @param decision - The rule that chose the role, when it was just chosen.
 * @returns The decision.
 */
async function decideRepository(
  session: AgentSession,
  integration: Integration,
  role: "manager" | "worker",
  snapshot: IssueSnapshot,
  decision: RoleDecision | null,
): Promise<RepositoryDecision> {
  if (session.repository) {
    return {
      kind: "resolved",
      repository: session.repository,
      announce: false,
    };
  }
  if (decision?.rule?.repository) {
    return {
      kind: "resolved",
      repository: decision.rule.repository,
      announce: true,
    };
  }
  const eligible = await eligibleRunners(api.db.db, {
    projectId: session.projectId,
    role,
    repository: undefined,
    issue: snapshot,
  });
  const candidates = repositoryCandidates(eligible);
  if (candidates.length === 0) {
    return role === "manager"
      ? { kind: "resolved", repository: null, announce: false }
      : { kind: "unresolved" };
  }
  if (candidates.length === 1) {
    return { kind: "resolved", repository: candidates[0], announce: true };
  }

  const settings = await getRoutingSettings(api.db.db, session.projectId);
  let ranked: string[] = [];
  try {
    const { issueRepositorySuggestions } = await linearRequest(
      integration,
      IssueRepositorySuggestions,
      {
        issueId: session.externalIssueId,
        agentSessionId: session.externalSessionId,
        candidateRepositories: candidates.map(candidateRepository),
      },
      { idempotent: true },
    );
    const suggestions = [...issueRepositorySuggestions.suggestions].sort(
      (a, b) => b.confidence - a.confidence,
    );
    const remoteOf = (s: {
      hostname: string | null;
      repositoryFullName: string;
    }) =>
      candidates.find(
        (c) =>
          candidateRepository(c).repositoryFullName.toLowerCase() ===
            s.repositoryFullName.toLowerCase() &&
          (!s.hostname ||
            candidateRepository(c).hostname === s.hostname.toLowerCase()),
      );
    const top = suggestions[0];
    const topRemote = top ? remoteOf(top) : undefined;
    if (top && topRemote && top.confidence >= settings.repositoryConfidence) {
      return { kind: "resolved", repository: topRemote, announce: true };
    }
    ranked = suggestions
      .map(remoteOf)
      .filter((r): r is string => r !== undefined);
  } catch (e) {
    // Asking a person is the fallback either way; Linear being unsure and
    // Linear being unreachable end in the same question.
    api.logger.warn("issueRepositorySuggestions failed; asking instead", {
      agentSessionId: session.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const ordered = [...new Set([...ranked, ...candidates])].slice(
    0,
    MAX_REPOSITORY_OPTIONS,
  );
  return { kind: "ask", options: ordered.map(repositoryOption) };
}

/**
 * Prepare a session's unprepared turns: read the issue, choose the role by
 * the project's rules (naming the decision in a thought), and choose the
 * repository — or ask a person with a `select`. Safe to call repeatedly; a
 * session someone else is preparing is skipped. A Linear failure leaves the
 * turns as they were for the next pass (and the queue timeout bounds it).
 * @param agentSessionId - The session.
 * @returns The effects to apply.
 */
export async function prepareSession(
  agentSessionId: number,
): Promise<WorkEffects> {
  const key = `work:prepare:${agentSessionId}`;
  const lease = await acquireLock(key, 4 * config.linear.requestTimeoutMs);
  if (!lease) return noEffects();
  try {
    const [row] = await api.db.db
      .select({ session: agentSessions, integration: integrations })
      .from(agentSessions)
      .innerJoin(integrations, eq(integrations.id, agentSessions.integrationId))
      .where(eq(agentSessions.id, agentSessionId));
    if (!row || row.session.pendingRepositoryChoice) return noEffects();
    const { session, integration } = row;
    if (integration.status !== "active") return noEffects();

    let snapshot = session.issueSnapshot;
    let decision: RoleDecision | null = null;
    let repository: RepositoryDecision;
    try {
      if (!snapshot) {
        snapshot = await fetchIssueSnapshot(
          integration,
          session.externalIssueId,
        );
      }
      if (session.role === null) {
        const text = await fetchMentionText(integration, session);
        const rules = await listRoutingRules(api.db.db, session.projectId);
        decision = selectRole(
          rules,
          routingFacts(snapshot, session.origin, text),
        );
      }
      repository = await decideRepository(
        session,
        integration,
        decision?.role ?? session.role!,
        snapshot,
        decision,
      );
    } catch (e) {
      api.logger.warn("preparing a session's routing failed; will retry", {
        agentSessionId,
        error: e instanceof Error ? e.message : String(e),
      });
      return noEffects();
    }

    return await api.db.db.transaction((tx) =>
      applyPreparation(tx, session.id, snapshot!, decision, repository),
    );
  } finally {
    await releaseLock(key, lease);
  }
}

/**
 * Write what {@link prepareSession} decided, re-reading the session under its
 * lock: a stop or a second preparation may have landed meanwhile.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @param snapshot - The issue as read.
 * @param decision - The role decision, if this pass made it.
 * @param repository - The repository decision.
 * @returns The effects to apply.
 */
async function applyPreparation(
  tx: TxHandle,
  agentSessionId: number,
  snapshot: IssueSnapshot,
  decision: RoleDecision | null,
  repository: RepositoryDecision,
): Promise<WorkEffects> {
  const effects = noEffects();
  const session = await lockSession(tx, agentSessionId);
  if (session.pendingRepositoryChoice) return effects;
  const items = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, session.id),
        eq(workItems.status, "queued"),
        or(isNull(workItems.role), eq(workItems.repositoryResolved, false)),
      ),
    )
    .orderBy(asc(workItems.id))
    .for("update");
  if (items.length === 0) return effects;

  const role = session.role ?? decision?.role;
  if (!role) return effects;
  if (session.role === null && decision) {
    await tx
      .update(agentSessions)
      .set({ role, instruction: decision.text, issueSnapshot: snapshot })
      .where(eq(agentSessions.id, session.id));
    await enqueueActivity(tx, session.id, {
      type: "thought",
      body: roleThought(decision),
    });
    effects.deliver.add(session.id);
  } else if (!session.issueSnapshot) {
    await tx
      .update(agentSessions)
      .set({ issueSnapshot: snapshot })
      .where(eq(agentSessions.id, session.id));
  }

  const ids = items.map((i) => i.id);
  if (repository.kind === "resolved") {
    await resolveRepository(tx, session, ids, role, repository, effects);
  } else {
    await tx.update(workItems).set({ role }).where(inArray(workItems.id, ids));
    if (repository.kind === "ask") {
      await tx
        .update(agentSessions)
        .set({
          pendingRepositoryChoice: {
            workItemId: items[0].id,
            options: repository.options,
            misses: 0,
          },
        })
        .where(eq(agentSessions.id, session.id));
      await askRepository(
        tx,
        session.id,
        repositoryQuestion(session.issueIdentifier),
        repository.options,
      );
      effects.deliver.add(session.id);
    }
  }
  effects.route = true;
  return effects;
}

/**
 * Settle a session's repository and every unresolved turn's, saying which
 * one when the choice is news.
 * @param tx - The transaction.
 * @param session - The session, locked.
 * @param itemIds - Its unresolved queued items.
 * @param role - Its role.
 * @param decision - The resolution.
 * @param effects - Where to record the delivery.
 */
async function resolveRepository(
  tx: TxHandle,
  session: AgentSession,
  itemIds: number[],
  role: "manager" | "worker",
  decision: { repository: string | null; announce: boolean },
  effects: WorkEffects,
): Promise<void> {
  await tx
    .update(workItems)
    .set({ role, repository: decision.repository, repositoryResolved: true })
    .where(inArray(workItems.id, itemIds));
  if (decision.repository !== session.repository) {
    await tx
      .update(agentSessions)
      .set({ repository: decision.repository, pendingRepositoryChoice: null })
      .where(eq(agentSessions.id, session.id));
  }
  if (decision.repository && decision.announce) {
    await enqueueActivity(tx, session.id, {
      type: "thought",
      body: repositoryThought(decision.repository),
    });
    effects.deliver.add(session.id);
  }
}

/**
 * Enqueue a `select` elicitation offering repositories.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @param body - The question.
 * @param options - The repositories, best first.
 */
async function askRepository(
  tx: TxHandle,
  agentSessionId: number,
  body: string,
  options: RepositoryChoiceOption[],
): Promise<void> {
  await enqueueActivity(
    tx,
    agentSessionId,
    { type: "elicitation", body },
    {
      signal: "select",
      signalMetadata: {
        options: options.map((o) => ({ label: o.label, value: o.value })),
      },
    },
  );
}

/**
 * A person's answer to the repository question, arriving as an ordinary
 * prompt. A match settles the repository and lets the turn be placed; the
 * first miss asks once more; the second ends the turn with an `error` naming
 * the candidates.
 * @param tx - The transaction.
 * @param session - The session, locked, with a pending choice.
 * @param body - What the person typed (or picked).
 * @returns The effects to apply.
 */
export async function answerRepositoryChoice(
  tx: TxHandle,
  session: AgentSession,
  body: string,
): Promise<WorkEffects> {
  const effects = noEffects();
  const choice = session.pendingRepositoryChoice!;
  effects.deliver.add(session.id);
  const items = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, session.id),
        eq(workItems.status, "queued"),
      ),
    )
    .orderBy(asc(workItems.id))
    .for("update");

  const picked = parseRepositoryAnswer(body, choice.options);
  if (picked) {
    const unresolved = items.filter((i) => !i.repositoryResolved);
    await resolveRepository(
      tx,
      { ...session, repository: null },
      unresolved.map((i) => i.id),
      session.role ?? "worker",
      { repository: picked.remote, announce: true },
      effects,
    );
    await tx
      .update(agentSessions)
      .set({ pendingRepositoryChoice: null })
      .where(eq(agentSessions.id, session.id));
    effects.route = true;
    return effects;
  }

  if (choice.misses === 0) {
    await tx
      .update(agentSessions)
      .set({ pendingRepositoryChoice: { ...choice, misses: 1 } })
      .where(eq(agentSessions.id, session.id));
    await askRepository(tx, session.id, REPOSITORY_RETRY_BODY, choice.options);
    return effects;
  }

  await tx
    .update(agentSessions)
    .set({ pendingRepositoryChoice: null })
    .where(eq(agentSessions.id, session.id));
  const names = choice.options.map((o) => o.label).join(", ");
  for (const [index, item] of items.entries()) {
    mergeEffects(
      effects,
      await finishWorkItem(tx, item, {
        status: "failed",
        cancelReason: index === 0 ? null : "superseded",
        fallback:
          index === 0
            ? {
                type: "error",
                body: `I still couldn't tell which repository you meant, so I've stopped here. I can work in: ${names}. Mention me again and name one.`,
              }
            : null,
      }),
    );
  }
  return effects;
}

/**
 * Format a duration in minutes for a person.
 * @param ms - The duration.
 * @returns `"30 minutes"`, `"1 minute"`.
 */
function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? "" : "s"}`;
}

/**
 * Tell a session why its turn is waiting — once per distinct reason, as an
 * ephemeral thought the next activity replaces.
 * @param tx - The transaction.
 * @param item - The waiting item.
 * @param reason - Why, as a sentence.
 * @param effects - Where to record the delivery.
 */
async function setWaiting(
  tx: TxHandle,
  item: WorkItem,
  reason: string,
  effects: WorkEffects,
): Promise<void> {
  if (item.waitingReason === reason) return;
  await tx
    .update(workItems)
    .set({ waitingReason: reason })
    .where(eq(workItems.id, item.id));
  await enqueueActivity(
    tx,
    item.agentSessionId,
    { type: "thought", body: reason },
    { ephemeral: true },
  );
  effects.deliver.add(item.agentSessionId);
}

/**
 * Offer one queued turn, or say why it waits, or expire it.
 *
 * 1. Waiting on a person (a repository question) → nothing, ever.
 * 2. Past the project's `queueTimeoutMs` since it was queued → `expired`, with
 *    an `error` naming the reason the data supports.
 * 3. Not yet prepared → nothing (preparation runs first in the same pass).
 * 4. No repository yet (no runner has one checked out) → waiting.
 * 5. The session's runner holds its worktree but cannot take it → waiting for
 *    that runner, until `stickyTimeoutMs`; then anyone, and the claimant
 *    starts fresh.
 * 6. Otherwise the best-ranked eligible runner that has not let an offer of
 *    this item lapse in the last `offerTtlMs × 3` is offered it.
 * @param itemId - The item.
 * @param now - The time this pass runs at.
 * @returns The effects to apply.
 */
async function offerItem(itemId: number, now: Date): Promise<WorkEffects> {
  return api.db.db.transaction(async (tx) => {
    const effects = noEffects();
    const locked = await lockItemWithSession(tx, itemId, true);
    if (!locked || locked.item.status !== "queued") return effects;
    const { item, session } = locked;
    if (session.pendingRepositoryChoice) return effects;

    const settings = await getRoutingSettings(tx, item.projectId);
    const waited = now.getTime() - item.queuedAt.getTime();
    const query: EligibilityQuery = {
      projectId: item.projectId,
      role: item.role ?? "worker",
      repository: item.repositoryResolved ? item.repository : undefined,
      issue: snapshotOf(session),
    };

    if (waited > settings.queueTimeoutMs) {
      const reason = item.role
        ? await explainUnplaceable(tx, query)
        : "I couldn't read the issue from Linear to route it.";
      return finishWorkItem(tx, item, {
        status: "expired",
        fallback: {
          type: "error",
          body: `No runner took this within ${minutes(settings.queueTimeoutMs)}. ${reason}`,
        },
      });
    }
    if (item.role === null) return effects;
    if (!item.repositoryResolved) {
      await setWaiting(
        tx,
        item,
        `Waiting for a runner: ${await explainUnplaceable(tx, query)}`,
        effects,
      );
      return effects;
    }

    const eligible = await eligibleRunners(tx, query);
    const cutoff = now.getTime() - settings.offerTtlMs * 3;
    const available = eligible.filter(
      (r) => (item.lapsedOffers[String(r.id)] ?? 0) <= cutoff,
    );
    const sticky = session.runnerId;
    if (
      sticky !== null &&
      settings.stickyTimeoutMs > 0 &&
      waited < settings.stickyTimeoutMs &&
      !available.some((r) => r.id === sticky)
    ) {
      const [holder] = await tx
        .select({ name: runners.name })
        .from(runners)
        .where(eq(runners.id, sticky));
      await setWaiting(
        tx,
        item,
        `Waiting for **${holder?.name ?? `runner ${sticky}`}**, which has this session's worktree.`,
        effects,
      );
      return effects;
    }

    const [chosen] = rankRunners(available, {
      stickyRunnerId: sticky,
      preferredUserId: item.preferredUserId,
    });
    if (!chosen) {
      const reason =
        eligible.length > 0
          ? "every runner that could take it just let an offer lapse; trying again shortly."
          : await explainUnplaceable(tx, query);
      await setWaiting(tx, item, `Waiting for a runner: ${reason}`, effects);
      return effects;
    }

    await tx
      .update(workItems)
      .set({
        status: "offered",
        offeredToRunnerId: chosen.id,
        offerExpiresAt: new Date(now.getTime() + settings.offerTtlMs),
        agentId: chosen.agentId,
        waitingReason: null,
      })
      .where(eq(workItems.id, item.id));
    effects.frames.set(chosen.id, "work");
    return effects;
  });
}

/**
 * Put offers that lapsed back in the queue, remembering who let them lapse
 * so the next offer goes elsewhere. The queue and sticky timeouts keep
 * counting from when the item was queued.
 * @returns The items returned.
 */
async function lapseOffers(): Promise<number[]> {
  const rows = await api.db.db
    .update(workItems)
    .set({
      status: "queued",
      lapsedOffers: sql`${workItems.lapsedOffers} || jsonb_build_object(${workItems.offeredToRunnerId}::text, (extract(epoch from now()) * 1000)::bigint)`,
      offeredToRunnerId: null,
      offerExpiresAt: null,
      agentId: null,
    })
    .where(
      and(
        eq(workItems.status, "offered"),
        sql`${workItems.offerExpiresAt} <= now()`,
      ),
    )
    .returning({ id: workItems.id });
  return rows.map((r) => r.id);
}

/** What one {@link routeWork} pass did. */
export interface RouteResult {
  /** False when another pass held the routing lease. */
  ran: boolean;
  lapsed: number[];
  prepared: number;
  offered: number[];
  effects: WorkEffects;
}

/** How many queued turns one pass considers. */
const MAX_ITEMS_PER_PASS = 500;

/**
 * One routing pass: lapse expired offers, prepare sessions with unprepared
 * turns, then offer each session's next queued turn — in `id` order, one per
 * session, only for sessions with no turn under way.
 *
 * Offers are made under one Redis lease, so two passes never count capacity
 * at once; preparation (which calls Linear) runs before it, under per-session
 * leases, so a slow Linear never holds up placement elsewhere.
 * @returns What it did.
 */
export async function routeWork(): Promise<RouteResult> {
  const result: RouteResult = {
    ran: false,
    lapsed: [],
    prepared: 0,
    offered: [],
    effects: noEffects(),
  };
  result.lapsed = await lapseOffers();

  const unprepared = await api.db.db
    .selectDistinct({ agentSessionId: workItems.agentSessionId })
    .from(workItems)
    .innerJoin(agentSessions, eq(agentSessions.id, workItems.agentSessionId))
    .where(
      and(
        eq(workItems.status, "queued"),
        or(isNull(workItems.role), eq(workItems.repositoryResolved, false)),
        isNull(agentSessions.pendingRepositoryChoice),
      ),
    )
    .limit(50);
  for (const { agentSessionId } of unprepared) {
    const effects = await prepareSession(agentSessionId);
    if (effects.route) result.prepared++;
    mergeEffects(result.effects, effects);
  }

  const key = "work:route";
  const lease = await acquireLock(key, 60_000);
  if (!lease) return result;
  result.ran = true;
  try {
    const next = await api.db.db.execute<{ id: number }>(sql`
      SELECT id FROM (
        SELECT DISTINCT ON (w.agent_session_id) w.id
        FROM work_items w
        WHERE w.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM work_items a
            WHERE a.agent_session_id = w.agent_session_id
              AND a.status IN ('offered', 'claimed', 'running'))
        ORDER BY w.agent_session_id, w.id
      ) n ORDER BY id LIMIT ${MAX_ITEMS_PER_PASS}
    `);
    const now = new Date();
    for (const { id } of next.rows) {
      const effects = await offerItem(Number(id), now);
      if (effects.frames.size > 0) result.offered.push(Number(id));
      mergeEffects(result.effects, effects);
    }
  } finally {
    await releaseLock(key, lease);
  }
  // Routing's own offers need no second pass.
  result.effects.route = false;
  return result;
}

/**
 * Keep sessions that are waiting **on Hypotenuse** from going `stale`: a
 * session with a queued turn (no runner yet, a sticky runner away, a lease
 * that lapsed) and none under way, whose newest outbound activity is older
 * than 25 minutes, gets an ephemeral thought saying what it waits for. A
 * session waiting on a **person** — a repository question — is left alone:
 * stale is the right state for a question nobody has answered. One with a
 * turn under way is the daemon's to keep alive.
 * @param quietMs - How long without an outbound activity counts as quiet.
 * @returns The sessions kept alive.
 */
export async function keepaliveSessions(
  quietMs = KEEPALIVE_AFTER_MS,
): Promise<number[]> {
  const cutoff = new Date(Date.now() - quietMs);
  const rows = await api.db.db.execute<{
    agent_session_id: number;
    waiting_reason: string | null;
  }>(sql`
    SELECT DISTINCT ON (w.agent_session_id) w.agent_session_id, w.waiting_reason
    FROM work_items w
    JOIN agent_sessions s ON s.id = w.agent_session_id
    JOIN integrations i ON i.id = s.integration_id
    WHERE w.status = 'queued'
      AND s.pending_repository_choice IS NULL
      -- A turn under way is the daemon's to keep alive, follow-ups or not.
      AND NOT EXISTS (
        SELECT 1 FROM work_items a
        WHERE a.agent_session_id = s.id
          AND a.status IN ('offered', 'claimed', 'running'))
      AND i.status = 'active'
      AND coalesce(
        (SELECT max(a.created_at) FROM agent_activities a
          WHERE a.agent_session_id = s.id AND a.direction = 'outbound'),
        s.created_at) < ${cutoff}
    ORDER BY w.agent_session_id, w.id
  `);
  const kept: number[] = [];
  for (const row of rows.rows) {
    const id = Number(row.agent_session_id);
    await api.db.db.transaction((tx) =>
      enqueueActivity(
        tx,
        id,
        {
          type: "thought",
          body: `Still queued. ${row.waiting_reason ?? "Waiting for a runner."}`,
        },
        { ephemeral: true },
      ),
    );
    kept.push(id);
  }
  return kept;
}
