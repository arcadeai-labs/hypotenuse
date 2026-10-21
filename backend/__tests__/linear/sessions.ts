import { asc, eq } from "drizzle-orm";
import { api } from "keryx";
import {
  type AgentSessionEventPayload,
  upsertFromWebhook,
} from "../../ops/AgentSessionOps";
import {
  type AgentActivity,
  agentActivities,
} from "../../schema/agent_activities";
import { type AgentSession, agentSessions } from "../../schema/agent_sessions";
import { type TriggerEvent, triggerEvents } from "../../schema/trigger_events";
import { runAction } from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, type useFinear } from "./finear";
import { integrationRow } from "./helpers";

/**
 * Helpers for the suites that drive agent sessions end to end: a person in
 * finear delegates, mentions, prompts, or stops; finear signs and delivers the
 * webhook to the server; the suite then runs the processing and delivery jobs
 * in-process ({@link settle}) and reads what finear recorded.
 */

/** The harness `useFinear()` returns. */
export type Finear = ReturnType<typeof useFinear>;

/**
 * Poll until a check passes. Used only for what crosses a process boundary on
 * its own schedule — finear's webhook scheduler — never to wait out a timer
 * of ours.
 * @param check - Returns a value when done, or undefined/false to keep waiting.
 * @param timeoutMs - How long to wait.
 * @returns The check's value.
 */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

/**
 * Run the processing, routing, and delivery jobs until there is nothing left
 * to do — what the workers would do, but in this process and in a known
 * order.
 * @param rounds - The most passes to make.
 */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const processed = await runAction<{ processed: number }>(
      "triggers:process-pending",
      { graceMs: 0 },
    );
    const routed = await runAction<{ prepared: number; offered: number[] }>(
      "work:route",
    );
    const delivered = await runAction<{ sent: number; failed: number }>(
      "activities:deliver-due",
    );
    if (
      processed.processed === 0 &&
      routed.prepared === 0 &&
      routed.offered.length === 0 &&
      delivered.sent === 0 &&
      delivered.failed === 0
    ) {
      return;
    }
  }
}

/**
 * Create an issue in the primary fixture team, as Human 1.
 * @param linear - The harness.
 * @param title - The title.
 * @returns The issue's id and identifier.
 */
export async function createIssue(
  linear: Finear,
  title = "Fix the flaky test",
): Promise<{ id: string; identifier: string }> {
  const reply = await linear.graphql<{
    issueCreate: { issue: { id: string; identifier: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
    {
      input: {
        teamId: FINEAR_FIXTURES.primary.team,
        title,
        description: `Steps to reproduce ${title}`,
      },
    },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.issueCreate.issue;
}

/**
 * Delegate an issue to the app as Human 1, which starts a session.
 * @param linear - The harness.
 * @param issueId - The issue.
 * @param appUserId - The app user.
 * @returns The Linear session id.
 */
export async function delegate(
  linear: Finear,
  issueId: string,
  appUserId: string,
): Promise<string> {
  const result = await linear.control<{ entity: { id: string } }>(
    "/__test/agents/delegate",
    { issueId, appUserId },
  );
  return result.entity.id;
}

/**
 * Wait for the server to have recorded a delivery matching a check.
 * @param check - Which event.
 * @returns The event row.
 */
export async function recordedEvent(
  check: (event: TriggerEvent) => boolean,
): Promise<TriggerEvent> {
  return waitFor(async () => {
    const rows = await api.db.db
      .select()
      .from(triggerEvents)
      .orderBy(asc(triggerEvents.id));
    return rows.find(check);
  });
}

/**
 * The mirror row for a Linear session.
 * @param externalSessionId - Linear's id.
 * @returns The row, or undefined.
 */
export async function sessionRow(
  externalSessionId: string,
): Promise<AgentSession | undefined> {
  const [row] = await api.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.externalSessionId, externalSessionId));
  return row;
}

/**
 * A session's activity rows in `seq` order.
 * @param agentSessionId - The mirror's id.
 * @returns The rows.
 */
export async function activityRows(
  agentSessionId: number,
): Promise<AgentActivity[]> {
  return api.db.db
    .select()
    .from(agentActivities)
    .where(eq(agentActivities.agentSessionId, agentSessionId))
    .orderBy(asc(agentActivities.seq));
}

/**
 * A session finear holds `pending`, mirrored but not answered: a delegation's
 * `created` is recorded, marked handled, and mirrored with the production
 * upsert — and no acknowledgement is enqueued. For suites that want every
 * activity on a session to be one they put there.
 * @param linear - The harness.
 * @param projectId - The connected project.
 * @param appUserId - The app user to delegate to.
 * @param title - The issue title.
 * @returns The mirror row.
 */
export async function mirroredQuietly(
  linear: Finear,
  projectId: number,
  appUserId: string,
  title: string,
): Promise<AgentSession> {
  const issue = await createIssue(linear, title);
  const externalSessionId = await delegate(linear, issue.id, appUserId);
  const event = await recordedEvent(
    (e) =>
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
      externalSessionId,
  );
  await api.db.db
    .update(triggerEvents)
    .set({ processedAt: new Date(), outcome: "handled" })
    .where(eq(triggerEvents.id, event.id));
  const integration = await integrationRow(projectId);
  return api.db.db.transaction(
    async (tx) =>
      (
        await upsertFromWebhook(
          tx,
          integration,
          event.payload as unknown as AgentSessionEventPayload,
        )
      ).session,
  );
}

/** An activity as finear reports it. */
export interface FinearActivity {
  id: string;
  createdAt: string;
  ephemeral: boolean;
  signal: string | null;
  content: { __typename: string; body?: string };
}

/**
 * A session's status and activities as finear holds them, read as the app.
 * @param linear - The harness.
 * @param token - The app's access token.
 * @param externalSessionId - Linear's id.
 * @returns Status and activities, oldest first.
 */
export async function finearSession(
  linear: Finear,
  token: string,
  externalSessionId: string,
): Promise<{ status: string; activities: FinearActivity[] }> {
  const reply = await linear.graphql<{
    agentSession: {
      status: string;
      activities: { nodes: FinearActivity[] };
    };
  }>(
    `Bearer ${token}`,
    `query($id: String!) { agentSession(id: $id) { status activities(first: 100) { nodes { id createdAt ephemeral signal content { __typename ... on AgentActivityThoughtContent { body } ... on AgentActivityResponseContent { body } ... on AgentActivityErrorContent { body } ... on AgentActivityPromptContent { body } ... on AgentActivityElicitationContent { body } } } } } }`,
    { id: externalSessionId },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return {
    status: reply.data.agentSession.status,
    activities: reply.data.agentSession.activities.nodes,
  };
}
