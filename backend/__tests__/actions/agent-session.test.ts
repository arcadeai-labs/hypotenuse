import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { AgentSessionActivities } from "../../actions/agent-session/agent-session-activities";
import type { AgentSessionList } from "../../actions/agent-session/agent-session-list";
import type { AgentSessionView } from "../../actions/agent-session/agent-session-view";
import { ACK_BODY } from "../../ops/LinearWebhookOps";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * `agent-session:list`, `agent-session:view`, and `agent-session:activities`
 * over HTTP: a member reads the project's sessions and their conversations,
 * an outsider is refused, and another project's session is not found.
 */

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

const sessionIds: number[] = [];
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const { externalAppUserId } = await integrationRow(universe.projectId);
  for (const title of ["First", "Second", "Third"]) {
    const issue = await createIssue(linear, title);
    const externalSessionId = await delegate(
      linear,
      issue.id,
      externalAppUserId,
    );
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    await settle();
    sessionIds.push((await sessionRow(externalSessionId))!.id);
  }
}, HOOK_TIMEOUT);

/**
 * GET an API path as someone.
 * @param path - The path and query.
 * @param sessionId - Who asks.
 * @returns Status and parsed body.
 */
async function get<T>(path: string, sessionId: string) {
  const res = await fetch(`${url}/api${path}`, {
    headers: cookieHeader(sessionId),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe("agent-session:list", () => {
  test("a member lists the project's sessions, newest first, paginated", async () => {
    const { status, body } = await get<ActionResponse<AgentSessionList>>(
      `/agent-sessions?projectId=${universe.projectId}&limit=2`,
      universe.luigi.sessionId,
    );
    expect(status).toBe(200);
    expect(body.agentSessions.map((s) => s.id)).toEqual(
      [...sessionIds].reverse().slice(0, 2),
    );
    expect(body.pagination).toEqual({ page: 1, limit: 2, total: 3, pages: 2 });
    expect(body.agentSessions[0]).toMatchObject({
      issueTitle: "Third",
      origin: "delegation",
      status: "error",
      role: null,
      runnerId: null,
    });
  });

  test("filters by status and issue identifier", async () => {
    const all = await get<ActionResponse<AgentSessionList>>(
      `/agent-sessions?projectId=${universe.projectId}`,
      universe.toad.sessionId,
    );
    const identifier = all.body.agentSessions[1].issueIdentifier!;
    const one = await get<ActionResponse<AgentSessionList>>(
      `/agent-sessions?projectId=${universe.projectId}&issueIdentifier=${identifier.toLowerCase()}`,
      universe.toad.sessionId,
    );
    expect(one.body.agentSessions.map((s) => s.issueIdentifier)).toEqual([
      identifier,
    ]);
    const none = await get<ActionResponse<AgentSessionList>>(
      `/agent-sessions?projectId=${universe.projectId}&status=active`,
      universe.toad.sessionId,
    );
    expect(none.body.agentSessions).toEqual([]);
  });

  test("an outsider is refused, and a project with no sessions lists none", async () => {
    const refused = await get(
      `/agent-sessions?projectId=${universe.projectId}`,
      universe.bowser.sessionId,
    );
    expect(refused.status).toBe(403);
    const own = await get<ActionResponse<AgentSessionList>>(
      `/agent-sessions?projectId=${universe.bowser.projectId}`,
      universe.bowser.sessionId,
    );
    expect(own.body.agentSessions).toEqual([]);
  });
});

describe("agent-session:view", () => {
  test("a member sees one session with its Linear context", async () => {
    const { status, body } = await get<ActionResponse<AgentSessionView>>(
      `/agent-session/${sessionIds[0]}?projectId=${universe.projectId}`,
      universe.mario.sessionId,
    );
    expect(status).toBe(200);
    expect(body.agentSession).toMatchObject({
      id: sessionIds[0],
      issueTitle: "First",
      promptContext: expect.stringContaining("First"),
      externalUrls: [],
      plan: null,
    });
    expect(body.agentSession).not.toHaveProperty("creatorEmail");
  });

  test("another project's session is not found, and an outsider is refused", async () => {
    const elsewhere = await get(
      `/agent-session/${sessionIds[0]}?projectId=${universe.bowser.projectId}`,
      universe.bowser.sessionId,
    );
    expect(elsewhere.status).toBe(404);
    const outsider = await get(
      `/agent-session/${sessionIds[0]}?projectId=${universe.projectId}`,
      universe.bowser.sessionId,
    );
    expect(outsider.status).toBe(403);
  });
});

describe("agent-session:activities", () => {
  test("both directions in order, with delivery status, paged by afterSeq", async () => {
    const { status, body } = await get<ActionResponse<AgentSessionActivities>>(
      `/agent-session/${sessionIds[0]}/activities?projectId=${universe.projectId}`,
      universe.luigi.sessionId,
    );
    expect(status).toBe(200);
    expect(
      body.activities.map((a) => [
        a.seq,
        a.direction,
        a.contentType,
        a.deliveryStatus,
      ]),
    ).toEqual([
      [1, "outbound", "thought", "sent"],
      [2, "outbound", "error", "sent"],
    ]);
    expect(body.activities[0].content).toEqual({
      type: "thought",
      body: ACK_BODY,
    });
    expect(body.pagination.total).toBe(2);

    const newer = await get<ActionResponse<AgentSessionActivities>>(
      `/agent-session/${sessionIds[0]}/activities?projectId=${universe.projectId}&afterSeq=1`,
      universe.luigi.sessionId,
    );
    expect(newer.body.activities.map((a) => a.seq)).toEqual([2]);
  });

  test("an outsider is refused, and another project's session is not found", async () => {
    expect(
      (
        await get(
          `/agent-session/${sessionIds[0]}/activities?projectId=${universe.projectId}`,
          universe.bowser.sessionId,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          `/agent-session/${sessionIds[0]}/activities?projectId=${universe.bowser.projectId}`,
          universe.bowser.sessionId,
        )
      ).status,
    ).toBe(404);
  });
});
