import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import type { AgentSessionView } from "../../actions/agent-session/agent-session-view";
import type { ProjectOverview } from "../../actions/project/project-overview";
import { agentSessions } from "../../schema/agent_sessions";
import { runners } from "../../schema/runners";
import { triggerEvents } from "../../schema/trigger_events";
import { workItems } from "../../schema/work_items";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  ago,
  delegatedSession,
  itemsOf,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * `project:overview` — the project home's one read — counts what the rows
 * say, over the window asked for; and `agent-session:view` carries a
 * session's turns, runner, and issuer.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

type Overview = Awaited<ReturnType<ProjectOverview["run"]>>["overview"];
type View = Awaited<ReturnType<AgentSessionView["run"]>>;

let appUserId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
}, HOOK_TIMEOUT);

/**
 * Read the overview as a person.
 * @param sessionId - Who reads.
 * @param window - The window.
 * @param projectId - The project.
 * @returns The status and overview.
 */
async function overview(
  sessionId: string,
  window: "24h" | "7d" = "24h",
  projectId = universe.projectId,
): Promise<{ status: number; overview: Overview }> {
  const res = await fetch(
    `${universe.url}/api/project/overview?projectId=${projectId}&window=${window}`,
    { headers: cookieHeader(sessionId) },
  );
  const body = (await res.json()) as { overview: Overview };
  return { status: res.status, overview: body.overview };
}

describe("project:overview", () => {
  test("an outsider is refused; a project with nothing has zeroes, not nulls", async () => {
    expect((await overview(universe.bowser.sessionId)).status).toBe(403);
    const empty = await overview(
      universe.toad.sessionId,
      "24h",
      universe.toad.projectId,
    );
    expect(empty.status).toBe(200);
    expect(empty.overview).toMatchObject({
      window: "24h",
      linear: null,
      runners: { online: 0, draining: 0, offline: 0, used: 0, total: 0 },
      sessions: { total: 0, medianAckMs: null, medianClaimMs: null },
      queue: { items: [], expired: 0 },
    });
  });

  test("counts match the rows, and the window bounds them", async () => {
    // Two sessions with no runner: both queued, waiting for one.
    const first = await delegatedSession(linear, appUserId, "Overview one");
    const second = await delegatedSession(linear, appUserId, "Overview two");
    // A third, started three days ago: in the week, not the day.
    const old = await delegatedSession(linear, appUserId, "Overview old");
    await api.db.db
      .update(agentSessions)
      .set({ createdAt: ago(3 * 86_400_000) })
      .where(eq(agentSessions.id, old.session.id));
    const [oldItem] = await itemsOf(old.session.id);
    await api.db.db
      .update(workItems)
      .set({ status: "expired", finishedAt: ago(2 * 86_400_000) })
      .where(eq(workItems.id, oldItem.id));

    const integrationId = (await integrationRow(universe.projectId)).id;
    for (const receivedAt of [new Date(), ago(2 * 86_400_000)]) {
      await api.db.db.insert(triggerEvents).values({
        type: "linear",
        deliveryId: crypto.randomUUID(),
        integrationId,
        eventType: "AgentSessionEvent",
        action: "created",
        webhookTimestamp: receivedAt,
        payload: {},
        receivedAt,
        processedAt: receivedAt,
        outcome: "failed",
        error: "a test failure",
      });
    }

    // Runners: one online, one draining, one never seen.
    const online = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      "overview-online",
      {
        limits: { maxParallelJobs: 3 },
        capabilities: {
          roles: ["manager"],
          agents: [{ id: "claude", preset: "claude", available: true }],
          repositories: [],
          subscriptions: { teams: [], projects: [], labels: [] },
        },
      },
    );
    const draining = await ScriptedDaemon.register(
      universe.url,
      universe.luigi,
      universe.projectId,
      "overview-draining",
      { draining: true },
    );
    await ScriptedDaemon.register(
      universe.url,
      universe.luigi,
      universe.projectId,
      "overview-never",
    );
    await online.heartbeat();
    await draining.heartbeat();
    await route();

    const day = (await overview(universe.luigi.sessionId, "24h")).overview;
    expect(day.linear).toMatchObject({ status: "active", failedDeliveries: 1 });
    expect(day.linear?.lastWebhookAt).toBeGreaterThan(Date.now() - 60_000);
    expect(day.runners).toMatchObject({
      online: 1,
      draining: 1,
      offline: 1,
      used: 0,
      total: 3,
    });
    expect(day.runners.oldestHeartbeatAt).not.toBeNull();
    expect(day.sessions.total).toBe(2);
    expect(day.sessions.byRole.worker).toBe(2);
    expect(day.sessions.medianAckMs).not.toBeNull();
    expect(day.sessions.medianClaimMs).toBeNull();
    const queued = day.queue.items.map((i) => i.agentSessionId);
    expect(queued).toEqual([first.session.id, second.session.id]);
    for (const item of day.queue.items) {
      expect(item.status).toBe("queued");
      // The online runner plays only manager; the one that plays worker is
      // draining — the nearer miss names the wait.
      expect(item.waitingCode).toBe("draining");
      expect(item.waitingReason).toContain("Waiting for a runner");
      expect(item.ageMs).toBeGreaterThanOrEqual(0);
    }
    expect(day.queue.expired).toBe(0);

    const week = (await overview(universe.luigi.sessionId, "7d")).overview;
    expect(week.sessions.total).toBe(3);
    expect(week.linear?.failedDeliveries).toBe(2);
    expect(week.queue.expired).toBe(1);
  });
});

describe("agent-session:view", () => {
  test("carries the session's turns, the runner holding it, and who it was for", async () => {
    // Clear the queue the overview left, so the new runner takes this session.
    await api.db.db
      .update(workItems)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(workItems.status, "queued"));
    const laptop = await ScriptedDaemon.register(
      universe.url,
      universe.toad,
      universe.projectId,
      "view-laptop",
    );
    await laptop.heartbeat();
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Viewed in the dashboard",
    );
    const turn = await laptop.claim();
    expect(turn?.agentSessionId).toBe(session.id);

    const res = await fetch(
      `${universe.url}/api/agent-session/${session.id}?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.luigi.sessionId) },
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as View;
    expect(view.runner).toEqual({
      id: laptop.id,
      name: "view-laptop",
      status: "online",
      owner: { id: universe.toad.userId, name: universe.toad.name },
    });
    expect(view.workItems).toHaveLength(1);
    expect(view.workItems[0]).toMatchObject({
      id: turn!.workItemId,
      kind: "session_created",
      status: "claimed",
      role: "worker",
      runnerId: laptop.id,
      runnerName: "view-laptop",
      waitingCode: null,
    });
    expect(view.workItems[0].claimedAt).not.toBeNull();
    expect(view.issuer.name).toBeTruthy();
    expect(view.issuer.externalUserId).toBeTruthy();
    await laptop.complete(turn!.workItemId, "completed");
    await api.db.db
      .update(runners)
      .set({ status: "offline" })
      .where(eq(runners.id, laptop.id));
  });
});
