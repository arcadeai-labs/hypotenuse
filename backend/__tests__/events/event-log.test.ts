import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import type { SerializedTriggerEvent } from "../../ops/TriggerEventOps";
import {
  projectEventsChannel,
  UNKNOWN_INTEGRATION_SUMMARY,
} from "../../ops/TriggerEventOps";
import { triggerEvents } from "../../schema/trigger_events";
import {
  FINEAR_FIXTURES,
  FINEAR_PRIMARY_KEY,
  useFinear,
} from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { agentSessionEvent, deliver, webhookSession } from "../linear/inject";
import { recordedEvent, sessionRow, settle } from "../linear/sessions";
import {
  delegatedSession,
  personSays,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { eventually, openSocket, subscribe } from "../runners/helpers";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The event log: `trigger-event:list` and `trigger-event:view` over real
 * deliveries from finear — what each did, the session and turn it touched,
 * how that turn was routed (role, rule, runner, or why it waits), who may
 * read it, and the payload only for admins.
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

let appUserId: string;
let organizationId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  appUserId = row.externalAppUserId;
  organizationId = row.externalWorkspaceId;
}, HOOK_TIMEOUT);

interface ListBody {
  triggerEvents: SerializedTriggerEvent[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

/**
 * GET an event log route as a user.
 * @param path - The route under `/api`.
 * @param user - Who asks.
 * @param params - The query; `projectId` defaults to the shared project.
 * @returns The status and the parsed body.
 */
async function get<T>(
  path: string,
  user: TestUser,
  params: Record<string, string | number | boolean> = {},
): Promise<{ status: number; body: T }> {
  const query = new URLSearchParams(
    Object.entries({ projectId: universe.projectId, ...params }).map(
      ([k, v]): [string, string] => [k, String(v)],
    ),
  );
  const res = await fetch(`${universe.url}/api${path}?${query}`, {
    headers: cookieHeader(user.sessionId),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * The shared project's log as Peach reads it.
 * @param params - Filters.
 * @returns The page.
 */
async function list(
  params: Record<string, string | number | boolean> = {},
): Promise<ListBody> {
  const { status, body } = await get<ListBody>(
    "/trigger-events",
    universe.peach,
    params,
  );
  expect(status).toBe(200);
  return body;
}

/**
 * Change an issue in finear, which delivers an `Issue` webhook.
 * @param id - The issue.
 * @param input - The change.
 */
async function updateIssue(
  id: string,
  input: Record<string, unknown>,
): Promise<void> {
  const reply = await linear.graphql(
    FINEAR_PRIMARY_KEY,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id, input },
  );
  if (reply.errors) throw new Error(JSON.stringify(reply.errors));
}

/** The first test's delegation, which later tests read again. */
let delegation: Awaited<ReturnType<typeof delegatedSession>>;

describe("trigger-event:list", () => {
  test("a delegation started a session, routed to the default worker, and says why its turn waits", async () => {
    delegation = await delegatedSession(linear, appUserId, "Log me");
    const { session, issue } = delegation;
    const body = await list({ agentSessionId: session.id });
    expect(body.pagination).toEqual({ page: 1, limit: 25, total: 1, pages: 1 });
    const [event] = body.triggerEvents;
    expect(event).toMatchObject({
      type: "linear",
      eventType: "AgentSessionEvent",
      action: "created",
      outcome: "handled",
      error: null,
      issueIdentifier: issue.identifier,
      summary: `Started a session on ${issue.identifier}, acknowledged it, and queued its first turn for routing.`,
      session: {
        id: session.id,
        issueTitle: "Log me",
        role: "worker",
        routingRule: null,
        dispatched: false,
      },
      turn: {
        kind: "session_created",
        status: "queued",
        runner: null,
        waitingCode: expect.any(String),
        waitingReason: expect.stringContaining("No runner"),
      },
    });
    expect(event.processedAt).toBeGreaterThanOrEqual(event.receivedAt);
    // The list never carries the body Linear sent.
    expect(event).not.toHaveProperty("payload");
  });

  test("a follow-up names the turn it queued", async () => {
    const { session, externalSessionId, issue } = delegation;
    await personSays(linear, externalSessionId, "Also add a test");
    const body = await list({ agentSessionId: session.id });
    expect(body.triggerEvents.map((e) => e.action)).toEqual([
      "prompted",
      "created",
    ]);
    const [prompted, created] = body.triggerEvents;
    expect(prompted).toMatchObject({
      outcome: "handled",
      summary: `Queued the follow-up on ${issue.identifier} as a new turn, behind one that has not ended.`,
      turn: { kind: "prompt", status: "queued" },
    });
    expect(prompted.turn?.id).not.toBe(created.turn?.id);
  });

  test("a mention a rule routes names the rule and, once placed, the runner", async () => {
    const issue = (
      await linear.graphql<{
        issueCreate: { issue: { id: string; identifier: string } };
      }>(
        FINEAR_PRIMARY_KEY,
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
        { input: { teamId: FINEAR_FIXTURES.primary.team, title: "Plan it" } },
      )
    ).data!.issueCreate.issue;
    const comment = await linear.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
      { input: { issueId: issue.id, body: "/manage plan it" } },
    );
    const mentioned = await linear.control<{ entity: { id: string } }>(
      "/__test/agents/mention",
      {
        issueId: issue.id,
        appUserId,
        commentId: comment.data!.commentCreate.comment.id,
      },
    );
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        mentioned.entity.id,
    );
    await settle();
    const session = (await sessionRow(mentioned.entity.id))!;

    const manager = await ScriptedDaemon.register(
      universe.url,
      universe.peach,
      universe.projectId,
      "event-log-manager",
      {
        capabilities: {
          roles: ["manager"],
          agents: [{ id: "claude", preset: "claude", available: true }],
          repositories: [],
          subscriptions: { teams: [], projects: [], labels: [] },
        },
      },
    );
    await manager.heartbeat();
    await route();

    const [event] = (await list({ agentSessionId: session.id })).triggerEvents;
    expect(event).toMatchObject({
      action: "created",
      issueIdentifier: issue.identifier,
      session: {
        role: "manager",
        routingRule: { id: expect.any(Number), name: "/manage" },
      },
      turn: {
        status: "offered",
        runner: { id: manager.runner.id, name: "event-log-manager" },
        waitingCode: null,
      },
    });
  });

  test("an issue change Hypotenuse does not act on is ignored, and hideIgnored leaves it out", async () => {
    const { issue } = delegation;
    await updateIssue(issue.id, { title: "Log me, renamed" });
    const recorded = await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { title?: string } }).data?.title ===
          "Log me, renamed",
    );
    await settle();

    const issues = await list({ eventType: "Issue" });
    const event = issues.triggerEvents.find((e) => e.id === recorded.id);
    expect(event).toMatchObject({
      outcome: "ignored",
      issueIdentifier: issue.identifier,
      summary: `Ignored: a change to ${issue.identifier} that neither removed @hypotenuse as delegate nor closed it.`,
      session: null,
      turn: null,
    });

    const ignored = await list({ outcome: "ignored" });
    expect(ignored.triggerEvents.every((e) => e.outcome === "ignored")).toBe(
      true,
    );
    expect(ignored.triggerEvents.map((e) => e.id)).toContain(recorded.id);
    const acted = await list({ hideIgnored: true, limit: 100 });
    expect(acted.triggerEvents.map((e) => e.id)).not.toContain(recorded.id);
    expect(acted.triggerEvents.length).toBeGreaterThan(0);
  });

  test("newest first, paginated, and since bounds it", async () => {
    const all = await list({ limit: 100 });
    const received = all.triggerEvents.map((e) => e.receivedAt);
    expect(received).toEqual([...received].sort((a, b) => b - a));
    const page = await list({ limit: 2, page: 2 });
    expect(page.pagination).toEqual({
      page: 2,
      limit: 2,
      total: all.pagination.total,
      pages: Math.ceil(all.pagination.total / 2),
    });
    expect(page.triggerEvents.map((e) => e.id)).toEqual(
      all.triggerEvents.slice(2, 4).map((e) => e.id),
    );
    const future = await list({
      since: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.pagination.total).toBe(0);
  });

  test("a delivery for no connected workspace is recorded but in no project's log", async () => {
    const payload = agentSessionEvent(
      { organizationId: "not-a-connected-workspace", appUserId },
      { action: "created", agentSession: webhookSession() },
    );
    const delivered = await deliver(universe.url, payload);
    expect(delivered.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, delivered.deliveryId!));
    expect(row).toMatchObject({
      integrationId: null,
      outcome: "unknown_integration",
      summary: UNKNOWN_INTEGRATION_SUMMARY,
    });
    const all = await list({ limit: 100 });
    expect(all.triggerEvents.map((e) => e.id)).not.toContain(row.id);
    // Nor in anyone else's project.
    const toads = await get<ListBody>("/trigger-events", universe.toad, {
      projectId: universe.toad.projectId,
    });
    expect(toads.body.triggerEvents.map((e) => e.id)).not.toContain(row.id);
  });

  test("members read it; an outsider is refused", async () => {
    const member = await get<ListBody>("/trigger-events", universe.toad);
    expect(member.status).toBe(200);
    expect(member.body.pagination.total).toBeGreaterThan(0);
    const outsider = await get("/trigger-events", universe.bowser);
    expect(outsider.status).toBe(403);
  });
});

describe("trigger-event:view", () => {
  test("an admin sees the payload Linear sent; a member sees the routing without it", async () => {
    const [event] = (
      await list({ agentSessionId: delegation.session.id })
    ).triggerEvents.slice(-1);

    const admin = await get<{
      triggerEvent: SerializedTriggerEvent;
      payload: Record<string, unknown> | null;
    }>(`/trigger-event/${event.id}`, universe.peach);
    expect(admin.status).toBe(200);
    expect(admin.body.triggerEvent).toEqual(event);
    expect(admin.body.payload).toMatchObject({
      type: "AgentSessionEvent",
      action: "created",
      organizationId,
    });

    const member = await get<{
      triggerEvent: SerializedTriggerEvent;
      payload: unknown;
    }>(`/trigger-event/${event.id}`, universe.toad);
    expect(member.status).toBe(200);
    expect(member.body).toEqual({ triggerEvent: event, payload: null });
  });

  test("another project's event is not found, and an outsider is refused", async () => {
    const [event] = (
      await list({ agentSessionId: delegation.session.id })
    ).triggerEvents.slice(-1);
    const elsewhere = await get(`/trigger-event/${event.id}`, universe.toad, {
      projectId: universe.toad.projectId,
    });
    expect(elsewhere.status).toBe(404);
    const outsider = await get(`/trigger-event/${event.id}`, universe.bowser);
    expect(outsider.status).toBe(403);
  });
});

describe("project:<id>:events", () => {
  test("members subscribe, outsiders cannot, and a delivery pings with nothing in it", async () => {
    const channel = projectEventsChannel(universe.projectId);
    const outsider = await openSocket(universe.url, universe.bowser.sessionId);
    const watcher = await openSocket(universe.url, universe.luigi.sessionId);
    try {
      expect(await subscribe(outsider, channel)).toEqual({
        ok: false,
        error: "You are not a member of this project",
      });
      expect((await subscribe(watcher, channel)).ok).toBe(true);
      await delegatedSession(linear, appUserId, "Ping the log");
      const frames = () =>
        watcher.messages
          .flatMap((raw) => {
            const m = raw.message as
              | { channel?: string; message?: string }
              | undefined;
            return m?.channel === channel && typeof m.message === "string"
              ? [JSON.parse(m.message) as { event?: string }]
              : [];
          })
          // Keryx's own presence frames, not ours.
          .filter((f) => f.event !== "join" && f.event !== "leave");
      expect(await eventually(() => frames().length >= 2)).toBe(true);
      expect(new Set(frames().map((f) => JSON.stringify(f)))).toEqual(
        new Set([JSON.stringify({ event: "events" })]),
      );
    } finally {
      outsider.socket.close();
      watcher.socket.close();
    }
  });
});
