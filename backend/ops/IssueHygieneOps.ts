import { and, eq, isNull } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import {
  type HygieneOutcome,
  type WorkItemHygiene,
  workItems,
} from "../schema/work_items";
import { enqueueActivity } from "./ActivityOutboxOps";
import { linearRequest } from "./LinearOps";
import {
  GetIssue,
  type LinearIssue,
  type LinearWorkflowState,
  ListWorkflowStates,
  UpdateIssue,
} from "./linear/operations";
import { applyEffects, noEffects } from "./WorkItemOps";

/**
 * Issue hygiene: how an implementing agent keeps the issue tidy, the way
 * Linear's agent guidelines ask — enforced **on the server**, so the daemon
 * never holds `issueUpdate` rights it could misuse and a misbehaving agent
 * cannot skip it. It runs once per session, when its first turn is claimed
 * (`session_created` and `dispatch` items), after the claim commits:
 *
 * | Condition | Action |
 * |---|---|
 * | worker role, a **person** delegated the issue, and its state type is not `started`, `completed`, or `canceled` | move it to the team's first `started` state (lowest `position`) |
 * | the session was started by an automation (no creator), or by a mention | leave the state alone; triage stays with a person |
 * | worker role, and the issue has **no delegate** | set the delegate to the app user |
 * | always | **never** change the assignee; the person keeps ownership |
 * | manager role | nothing; a manager working on a PRD issue is not implementing it |
 *
 * Each rule's outcome is recorded on the work item's `hygiene`. A failure is
 * logged and posted as a thought ("Could not move ENG-123 to In Progress: …");
 * it never fails the claim — the work matters more than the status.
 */

/** How long a team's first started state is cached. */
export const STARTED_STATE_TTL_SECONDS = 600;

/** The state types that already count as begun or finished. */
const SETTLED_STATE_TYPES = new Set(["started", "completed", "canceled"]);

/** The work item kinds hygiene runs for: a session's first turn. */
export const HYGIENE_KINDS = new Set(["session_created", "dispatch"]);

/**
 * The Redis key a team's first started state is cached under.
 * @param integrationId - The integration.
 * @param teamId - Linear's team id.
 * @returns The key.
 */
export const startedStateKey = (integrationId: number, teamId: string) =>
  `linear:started-state:${integrationId}:${teamId}`;

/**
 * A team's first `started` workflow state (lowest `position`), cached per
 * team for {@link STARTED_STATE_TTL_SECONDS}.
 * @param integration - The integration.
 * @param teamId - Linear's team id.
 * @returns The state, or null when the team has none.
 */
export async function firstStartedState(
  integration: Integration,
  teamId: string,
): Promise<LinearWorkflowState | null> {
  const key = startedStateKey(integration.id, teamId);
  const cached = await api.redis.redis.get(key);
  if (cached) return JSON.parse(cached) as LinearWorkflowState | null;
  const data = await linearRequest(
    integration,
    ListWorkflowStates,
    { teamId },
    { idempotent: true },
  );
  const started = data.team.states.nodes
    .filter((s) => s.type === "started")
    .sort((a, b) => a.position - b.position)[0];
  const state = started ?? null;
  await api.redis.redis.set(
    key,
    JSON.stringify(state),
    "EX",
    STARTED_STATE_TTL_SECONDS,
  );
  return state;
}

/**
 * A short reason from a failed Linear call.
 * @param error - What it threw.
 * @returns The message.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the rules need about the session. */
interface HygieneInput {
  role: "manager" | "worker";
  humanDelegated: boolean;
  automation: boolean;
  appUserId: string;
}

/**
 * The started-state rule.
 * @param integration - The integration.
 * @param issue - The issue as Linear has it now.
 * @param input - The session.
 * @returns The outcome.
 */
async function moveToStarted(
  integration: Integration,
  issue: LinearIssue,
  input: HygieneInput,
): Promise<HygieneOutcome> {
  if (input.role === "manager")
    return { outcome: "skipped", detail: "manager role" };
  if (input.automation)
    return { outcome: "skipped", detail: "started by an automation" };
  if (!input.humanDelegated)
    return { outcome: "skipped", detail: "not a delegation" };
  if (SETTLED_STATE_TYPES.has(issue.state.type))
    return {
      outcome: "unchanged",
      detail: `already ${issue.state.type} (${issue.state.name})`,
    };
  const started = await firstStartedState(integration, issue.team.id);
  if (!started)
    return { outcome: "skipped", detail: "the team has no started state" };
  await linearRequest(integration, UpdateIssue, {
    id: issue.id,
    input: { stateId: started.id },
  });
  return { outcome: "moved", detail: started.name };
}

/**
 * The delegate rule.
 * @param integration - The integration.
 * @param issue - The issue as Linear has it now.
 * @param input - The session.
 * @returns The outcome.
 */
async function setDelegate(
  integration: Integration,
  issue: LinearIssue,
  input: HygieneInput,
): Promise<HygieneOutcome> {
  if (input.role === "manager")
    return { outcome: "skipped", detail: "manager role" };
  if (issue.delegate)
    return {
      outcome: "unchanged",
      detail:
        issue.delegate.id === input.appUserId
          ? "already delegated to the app"
          : "delegated to someone else",
    };
  await linearRequest(integration, UpdateIssue, {
    id: issue.id,
    input: { delegateId: input.appUserId },
  });
  return { outcome: "set", detail: "delegated to the app" };
}

/**
 * Apply issue hygiene for a claimed work item, once. Never throws: a failure
 * is recorded, logged, and posted as a thought.
 * @param workItemId - The claimed item.
 * @returns What it did, or null when it did not run (not a first turn, already
 *   done, or no usable integration).
 */
export async function applyIssueHygiene(
  workItemId: number,
): Promise<WorkItemHygiene | null> {
  const [row] = await api.db.db
    .select({
      item: workItems,
      session: agentSessions,
      integration: integrations,
    })
    .from(workItems)
    .innerJoin(agentSessions, eq(agentSessions.id, workItems.agentSessionId))
    .innerJoin(integrations, eq(integrations.id, agentSessions.integrationId))
    .where(eq(workItems.id, workItemId));
  if (!row || row.item.hygiene || !HYGIENE_KINDS.has(row.item.kind))
    return null;
  const { item, session, integration } = row;
  if (integration.status !== "active") return null;

  const input: HygieneInput = {
    role: item.role ?? "worker",
    humanDelegated:
      session.origin === "delegation" && session.creatorExternalUserId !== null,
    automation: session.creatorExternalUserId === null,
    appUserId: integration.externalAppUserId,
  };
  const failures: string[] = [];
  let state: HygieneOutcome;
  let delegate: HygieneOutcome;
  const label = session.issueIdentifier ?? "the issue";
  if (input.role === "manager") {
    state = { outcome: "skipped", detail: "manager role" };
    delegate = { outcome: "skipped", detail: "manager role" };
  } else {
    let issue: LinearIssue | null = null;
    try {
      issue = (
        await linearRequest(
          integration,
          GetIssue,
          { id: session.externalIssueId },
          { idempotent: true },
        )
      ).issue;
    } catch (error) {
      failures.push(`Could not read ${label}: ${reasonOf(error)}`);
    }
    if (!issue) {
      state = { outcome: "failed", detail: "could not read the issue" };
      delegate = { outcome: "failed", detail: "could not read the issue" };
    } else {
      try {
        state = await moveToStarted(integration, issue, input);
      } catch (error) {
        state = { outcome: "failed", detail: reasonOf(error) };
        failures.push(
          `Could not move ${label} to a started state: ${reasonOf(error)}`,
        );
      }
      try {
        delegate = await setDelegate(integration, issue, input);
      } catch (error) {
        delegate = { outcome: "failed", detail: reasonOf(error) };
        failures.push(
          `Could not set myself as ${label}'s delegate: ${reasonOf(error)}`,
        );
      }
    }
  }
  const hygiene: WorkItemHygiene = { state, delegate, at: Date.now() };
  const effects = noEffects();
  await api.db.db.transaction(async (tx) => {
    const written = await tx
      .update(workItems)
      .set({ hygiene })
      .where(and(eq(workItems.id, item.id), isNull(workItems.hygiene)))
      .returning({ id: workItems.id });
    if (written.length === 0) return;
    for (const body of failures) {
      await enqueueActivity(tx, session.id, { type: "thought", body });
      effects.deliver.add(session.id);
    }
  });
  if (failures.length) {
    api.logger.warn("issue hygiene failed", {
      workItemId: item.id,
      agentSessionId: session.id,
      failures: failures.join(" | "),
    });
  }
  await applyEffects(effects);
  return hygiene;
}
