import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { type DaemonHome, outbound, until } from "../daemon/helpers";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT, runAction } from "../setup";
import { alive, bodies, useE2E } from "./harness";

/**
 * A person presses Stop while the agent is in the middle of a long tool call,
 * end to end: the server tells the daemon, the daemon sends `session/cancel`,
 * the agent stops, and the last thing the person sees in Linear is a response
 * saying where the work stopped — the branch — with nothing after it, not
 * even from a server clock run with time moved past its threshold. An agent
 * that ignores `session/cancel` is killed once the runner's `stop_grace`
 * (two seconds in these homes) is over, and the session is answered the same
 * way.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "stop-laptop", {
    scenario: "ticking",
    turnMs: 120_000,
  });
}, HOOK_TIMEOUT);

/**
 * Wait until the agent process for a session has been sent its prompt, and
 * return that process's pid.
 * @param agentSessionId - The session.
 * @returns The agent's pid.
 */
async function agentPid(agentSessionId: number): Promise<number> {
  return until(
    async () =>
      home
        .received()
        .find(
          (r) =>
            r.method === "session/prompt" &&
            r.session === String(agentSessionId),
        )?.pid,
    30_000,
  );
}

/**
 * Wait for the session's first turn to reach a status.
 * @param agentSessionId - The session.
 * @param status - The status.
 * @returns The item.
 */
async function itemReaches(agentSessionId: number, status: string) {
  return until(async () => {
    const [item] = await itemsOf(agentSessionId);
    return item?.status === status ? item : null;
  }, 30_000);
}

/**
 * Wait until every outbound activity of a session has left the outbox, one
 * way or the other.
 * @param agentSessionId - The session.
 * @returns The rows.
 */
async function drained(agentSessionId: number) {
  return until(async () => {
    const rows = await outbound(agentSessionId);
    return rows.every((r) => r.deliveryStatus !== "pending") ? rows : null;
  });
}

/**
 * Run every server clock that could speak in a session, with time moved
 * past their thresholds, and assert none of them did.
 * @param agentSessionId - The session.
 */
async function serverStaysQuiet(agentSessionId: number): Promise<void> {
  const before = (await outbound(agentSessionId)).length;
  const items = (await itemsOf(agentSessionId)).length;
  await api.db.db
    .update(agentSessions)
    .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where(eq(agentSessions.id, agentSessionId));
  await runAction("sessions:keepalive");
  await runAction("work:route");
  await runAction("work:reap");
  await runAction("activities:deliver-due");
  expect((await outbound(agentSessionId)).length).toBe(before);
  expect((await itemsOf(agentSessionId)).length).toBe(items);
}

describe("stop mid-turn", () => {
  test("LC-BP-11 Stop during a tool call cancels the agent and says where the work stopped, then nothing more", async () => {
    const { externalSessionId, agentSessionId, issue } = await e2e.delegate(
      "Rebuild the search index",
    );
    await itemReaches(agentSessionId, "running");
    const pid = await agentPid(agentSessionId);
    // A tool call is under way: the agent has reported one in progress.
    await until(async () =>
      (await outbound(agentSessionId)).some(
        (r) => r.contentType === "action" && r.ephemeral,
      ),
    );

    await e2e.say(externalSessionId, "Stop", "stop");
    const stopped = await itemReaches(agentSessionId, "cancelled");
    expect(stopped.cancelReason).toBe("stop");
    expect(home.received().map((r) => r.method)).toContain("session/cancel");
    await until(async () => !alive(pid));

    const view = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length > 0,
    );
    const [response] = bodies(view, "AgentActivityResponseContent");
    expect(response).toStartWith(
      `Stopped at your request. Changes so far are on branch \`hypotenuse/${issue.identifier.toLowerCase()}-`,
    );
    expect(view.activities.at(-1)?.content.body).toBe(response);

    // Nothing follows the answer: the outbox is drained, the response is the
    // last row, and no server clock adds another.
    const rows = await drained(agentSessionId);
    expect(rows.at(-1)?.contentType).toBe("response");
    await serverStaysQuiet(agentSessionId);
    const after = await e2e.linearSession(externalSessionId, () => true);
    expect(after.activities.at(-1)?.content.body).toBe(response);
    expect(after.activities.length).toBe(view.activities.length);
  }, 60_000);

  test("an agent that ignores session/cancel is killed after stop_grace, and the session is still answered", async () => {
    home = await e2e.restart(home, "slow-cancel");
    const { externalSessionId, agentSessionId } =
      await e2e.delegate("Hang forever");
    await itemReaches(agentSessionId, "running");
    const pid = await agentPid(agentSessionId);
    expect(alive(pid)).toBe(true);

    await e2e.say(externalSessionId, "Stop", "stop");
    const stopped = await itemReaches(agentSessionId, "cancelled");
    expect(stopped.cancelReason).toBe("stop");
    expect(
      home
        .received()
        .some(
          (r) =>
            r.method === "session/cancel" &&
            r.session === String(agentSessionId),
        ),
    ).toBe(true);
    // It never answered the cancel; the daemon killed it.
    await until(async () => !alive(pid), 10_000);

    const view = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length > 0,
    );
    const [response] = bodies(view, "AgentActivityResponseContent");
    expect(response).toStartWith("Stopped at your request.");
    expect(view.activities.at(-1)?.content.body).toBe(response);
  }, 60_000);
});
