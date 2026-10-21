import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api } from "keryx";
import {
  STOP_UNCONFIRMED_BODY,
  STOPPED_BEFORE_START_BODY,
  STOPPED_NOTHING_BODY,
} from "../../ops/WorkItemOps";
import { auditLogs } from "../../schema/audit_logs";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { activityRows, finearSession, settle } from "../linear/sessions";
import {
  connect,
  eventually,
  frames,
  openSocket,
  sessionCookie,
  subscribe,
  type TestSocket,
} from "../runners/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  ago,
  delegatedSession,
  itemRow,
  itemsOf,
  personSays,
  reap,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Stopping: a person's Stop in Linear (or `agent-session:cancel` from
 * Hypotenuse) ends work that has not started at once, reaches a running turn
 * through the frame, the heartbeat, and the events answer, and is answered by
 * the server when the runner never confirms. Queued work behind the stopped
 * turn goes with it.
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
let token: string;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
  // Registered, but offline until a test heartbeats it.
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "stop-laptop",
    { limits: { maxParallelJobs: 5 } },
  );
}, HOOK_TIMEOUT);

/**
 * The last outbound activity of a session in the outbox.
 * @param agentSessionId - The session.
 * @returns The row.
 */
async function lastOutbound(agentSessionId: number) {
  return (await activityRows(agentSessionId))
    .filter((r) => r.direction === "outbound")
    .at(-1);
}

/**
 * The body of the last activity Linear holds for a session.
 * @param externalSessionId - Linear's id.
 * @returns The body.
 */
async function lastInLinear(externalSessionId: string) {
  await settle();
  const finear = await finearSession(linear, token, externalSessionId);
  return finear.activities.at(-1)?.content.body;
}

describe("work that has not started", () => {
  test("queued with no runner: cancelled and answered at once; a second stop finds nothing", async () => {
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Nobody home",
    );
    expect((await itemsOf(session.id))[0].status).toBe("queued");

    await personSays(linear, externalSessionId, "Stop", "stop");
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([["cancelled", "stop"]]);
    expect(await lastOutbound(session.id)).toMatchObject({
      contentType: "response",
      content: { type: "response", body: STOPPED_BEFORE_START_BODY },
      priority: "ack",
    });
    expect(await lastInLinear(externalSessionId)).toBe(
      STOPPED_BEFORE_START_BODY,
    );

    await personSays(linear, externalSessionId, "Stop again", "stop");
    expect(await lastOutbound(session.id)).toMatchObject({
      content: { type: "response", body: STOPPED_NOTHING_BODY },
      priority: "ack",
    });
  });

  test("offered but not claimed: cancelled, answered, and gone from the runner's offers", async () => {
    await laptop.heartbeat();
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Offered only",
    );
    const [item] = await itemsOf(session.id);
    expect(item.status).toBe("offered");
    expect((await laptop.heartbeat()).offers.map((o) => o.workItemId)).toEqual([
      item.id,
    ]);

    await personSays(linear, externalSessionId, "Stop", "stop");
    expect((await itemRow(item.id)).status).toBe("cancelled");
    expect((await laptop.heartbeat()).offers).toEqual([]);
    expect(await laptop.claim([item.id])).toBeNull();
    expect(await lastInLinear(externalSessionId)).toBe(
      STOPPED_BEFORE_START_BODY,
    );
  });
});

describe("a running turn", () => {
  let socket: TestSocket | undefined;
  afterAll(() => socket?.socket.close());

  test("LC-SIG-01 the runner is told three ways, may only answer, and its answer is what Linear shows", async () => {
    await laptop.heartbeat();
    const res = await connect(
      universe.url,
      laptop.runner.token,
      laptop.shape.machineId,
    );
    expect(res.status).toBe(200);
    socket = await openSocket(universe.url, sessionCookie(res));
    const channel = `runner:${laptop.id}`;
    expect((await subscribe(socket, channel)).ok).toBe(true);

    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Running when stopped",
    );
    const turn = await laptop.claim();
    await laptop.events(turn!.workItemId, [
      { type: "thought", body: "Halfway there" },
    ]);
    await personSays(linear, externalSessionId, "One more thing");
    const queued = (await itemsOf(session.id))[1];
    expect(queued.status).toBe("queued");

    await personSays(linear, externalSessionId, "Stop", "stop");
    expect(
      await eventually(() => frames(socket!, channel).includes("cancel")),
    ).toBe(true);
    expect((await laptop.heartbeat()).cancels).toEqual([
      { workItemId: turn!.workItemId, reason: "stop" },
    ]);
    const held = await itemRow(turn!.workItemId);
    expect(held.status).toBe("running");
    expect(held.cancelReason).toBe("stop");
    expect(held.cancelRequestedAt).not.toBeNull();
    // The queued follow-up went with it, silently.
    expect(await itemRow(queued.id)).toMatchObject({
      status: "cancelled",
      cancelReason: "superseded",
    });

    const answer = await laptop.events(turn!.workItemId, [
      { type: "action", action: "Editing", parameter: "a.ts" },
      { type: "plan", entries: [{ content: "x", status: "pending" }] },
      {
        type: "response",
        body: "Stopped. The fix is half-applied on the branch.",
      },
    ]);
    expect(answer.body).toEqual({
      accepted: 1,
      duplicates: 0,
      dropped: 2,
      cancelRequested: true,
    });
    expect((await laptop.complete(turn!.workItemId, "cancelled")).body).toEqual(
      { alreadyTerminal: false },
    );
    expect(await lastInLinear(externalSessionId)).toBe(
      "Stopped. The fix is half-applied on the branch.",
    );
    expect((await itemRow(turn!.workItemId)).status).toBe("cancelled");
  });

  test("a runner that never confirms is answered for, after the stop grace", async () => {
    await laptop.heartbeat();
    const { externalSessionId } = await delegatedSession(
      linear,
      appUserId,
      "Unresponsive runner",
    );
    const turn = await laptop.claim();
    await personSays(linear, externalSessionId, "Stop", "stop");
    expect((await reap()).stopped).not.toContain(turn!.workItemId);

    await laptop.heartbeat();
    await setCancelledLongAgo(turn!.workItemId);
    expect((await reap()).stopped).toContain(turn!.workItemId);
    expect((await itemRow(turn!.workItemId)).status).toBe("cancelled");
    expect(await lastInLinear(externalSessionId)).toBe(STOP_UNCONFIRMED_BODY);

    // The runner turns up late: accepted, and changes nothing.
    expect((await laptop.complete(turn!.workItemId, "cancelled")).body).toEqual(
      { alreadyTerminal: true },
    );
    expect(await lastInLinear(externalSessionId)).toBe(STOP_UNCONFIRMED_BODY);
  });
});

/**
 * Move a stop request past the default 30-second grace.
 * @param workItemId - The item being stopped.
 */
async function setCancelledLongAgo(workItemId: number): Promise<void> {
  await setItem(workItemId, { cancelRequestedAt: ago(31_000) });
}

describe("agent-session:cancel", () => {
  test("a plain member stops a session from Hypotenuse, audited; an outsider is refused", async () => {
    await laptop.heartbeat();
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Cancelled from the dashboard",
    );
    const cancel = (sessionId: string) =>
      fetch(`${universe.url}/api/agent-session/${session.id}/cancel`, {
        method: "POST",
        headers: authHeaders(sessionId),
        body: JSON.stringify({ projectId: universe.projectId }),
      });

    expect((await cancel(universe.bowser.sessionId)).status).toBe(403);
    expect((await itemsOf(session.id))[0].status).toBe("offered");

    const res = await cancel(universe.toad.sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentSession: { id: number } };
    expect(body.agentSession.id).toBe(session.id);
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([["cancelled", "dashboard"]]);
    expect(await lastInLinear(externalSessionId)).toBe(
      STOPPED_BEFORE_START_BODY,
    );

    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "agent-session:cancel"),
          eq(auditLogs.projectId, universe.projectId),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toMatchObject({
      userId: universe.toad.userId,
      targetType: "agent_session",
    });
  });
});
