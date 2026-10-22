import { beforeAll, describe, expect, test } from "bun:test";
import { type DaemonHome, outbound, until } from "../daemon/helpers";
import { itemsOf } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { authHeaders, HOOK_TIMEOUT } from "../setup";
import { alive, bodies, useE2E } from "./harness";

/**
 * A runner revoked in the middle of a turn, end to end. The revocation
 * reaches the connected daemon at once: it stops its agent and exits 78 (so
 * a service manager does not restart it). The turn is not lost — the *work*
 * is still wanted, only that machine is not — so the server puts it back in
 * the queue without counting an attempt, unstuck from the revoked runner,
 * and the next runner to come online claims it in a fresh worktree and
 * answers the person.
 */

const e2e = useE2E();

let doomed: DaemonHome;
beforeAll(async () => {
  doomed = await e2e.daemon(e2e.universe.mario, "doomed", {
    scenario: "ticking",
    turnMs: 120_000,
  });
}, HOOK_TIMEOUT);

describe("revoking a runner mid-turn", () => {
  test("the daemon stops its agent and exits; the turn is requeued and another runner answers", async () => {
    const { externalSessionId, agentSessionId } =
      await e2e.delegate("Upgrade the ORM");
    const running = await until(async () => {
      const [item] = await itemsOf(agentSessionId);
      return item?.status === "running" ? item : null;
    }, 30_000);
    expect(running.runnerId).toBe(doomed.runner.id);
    const pid = await until(
      async () =>
        doomed
          .received()
          .find(
            (r) =>
              r.method === "session/prompt" &&
              r.session === String(agentSessionId),
          )?.pid,
    );

    const res = await fetch(
      `${e2e.universe.url}/api/runner/${doomed.runner.id}`,
      {
        method: "DELETE",
        headers: authHeaders(e2e.universe.mario.sessionId),
        body: JSON.stringify({ projectId: e2e.universe.projectId }),
      },
    );
    expect(res.status).toBe(200);

    // The daemon heard, stopped its agent, and exited for good.
    const code = await Promise.race([
      doomed.proc?.exited,
      Bun.sleep(15_000).then(() => "timeout"),
    ]);
    expect(code).toBe(78);
    await until(async () => !alive(pid), 10_000);
    expect((await runnerRow(doomed.runner.id)).status).toBe("revoked");

    // The turn went back to the queue, uncounted and unstuck.
    const [requeued] = await itemsOf(agentSessionId);
    expect(requeued).toMatchObject({
      id: running.id,
      status: "queued",
      runnerId: null,
      attempts: running.attempts,
    });
    expect(requeued.stickyRunnerId).toBeNull();
    // Nothing the revoked daemon sent after the revocation was a final.
    expect(
      (await outbound(agentSessionId)).filter(
        (r) => r.contentType === "response" || r.contentType === "error",
      ),
    ).toEqual([]);

    // A new runner comes online and finishes the work.
    const next = await e2e.daemon(e2e.universe.luigi, "successor", {
      scenario: "happy",
    });
    const done = await until(async () => {
      const [item] = await itemsOf(agentSessionId);
      return item?.status === "completed" ? item : null;
    }, 30_000);
    expect(done.id).toBe(running.id);
    expect(done.runnerId).toBe(next.runner.id);
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    expect(bodies(view, "AgentActivityResponseContent")).toHaveLength(1);
    expect(view.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityResponseContent",
    );
  }, 90_000);
});
