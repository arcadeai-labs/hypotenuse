import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { type DaemonHome, outbound, until } from "../daemon/helpers";
import { FINEAR_PRIMARY_KEY } from "../linear/finear";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT, runAction } from "../setup";
import { alive, useE2E } from "./harness";

/**
 * A person removes `@hypotenuse` as the issue's delegate while the agent is
 * working, end to end: finear sends the `Issue` webhook, the server cancels
 * the turn as `delegate_removed`, the daemon stops the agent — and because
 * the person stepped away, nothing more reaches Linear: no stop message from
 * the daemon, no fallback from the server, and no clock (keepalive, routing,
 * the lease reaper) re-engages, even with time moved past their thresholds.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "undelegate-laptop", {
    scenario: "ticking",
    turnMs: 120_000,
  });
}, HOOK_TIMEOUT);

/**
 * Clear an issue's delegate in finear, as Human 1.
 * @param issueId - The issue.
 */
async function undelegate(issueId: string): Promise<void> {
  const reply = await e2e.linear.graphql(
    FINEAR_PRIMARY_KEY,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id: issueId, input: { delegateId: null } },
  );
  if (reply.errors) throw new Error(JSON.stringify(reply.errors));
}

describe("un-delegating mid-turn", () => {
  test("the turn stops, and nothing more is said in Linear", async () => {
    const { externalSessionId, agentSessionId, issue } = await e2e.delegate(
      "Refactor the billing module",
    );
    const running = await until(async () => {
      const [item] = await itemsOf(agentSessionId);
      return item?.status === "running" ? item : null;
    }, 30_000);
    const pid = await until(
      async () =>
        home
          .received()
          .find(
            (r) =>
              r.method === "session/prompt" &&
              r.session === String(agentSessionId),
          )?.pid,
    );
    // Let the agent's work show in Linear before the person walks away.
    const before = await e2e.linearSession(externalSessionId, (s) =>
      s.activities.some(
        (a) => a.content.__typename === "AgentActivityActionContent",
      ),
    );

    await undelegate(issue.id);
    const cancelled = await until(async () => {
      const [item] = await itemsOf(agentSessionId);
      return item?.status === "cancelled" ? item : null;
    }, 30_000);
    expect(cancelled.id).toBe(running.id);
    expect(cancelled.cancelReason).toBe("delegate_removed");
    expect(home.received().map((r) => r.method)).toContain("session/cancel");
    await until(async () => !alive(pid));

    // Whatever the daemon sent after the cancel was dropped or withdrawn:
    // no response or error was ever queued for Linear.
    await until(async () =>
      (await outbound(agentSessionId)).every(
        (r) => r.deliveryStatus !== "pending",
      ),
    );
    const rows = await outbound(agentSessionId);
    expect(
      rows.filter(
        (r) => r.contentType === "response" || r.contentType === "error",
      ),
    ).toEqual([]);

    // No server clock re-engages, with time moved past every threshold.
    const count = rows.length;
    const settled = await e2e.linearSession(externalSessionId, () => true);
    await api.db.db
      .update(agentSessions)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(agentSessions.id, agentSessionId));
    await runAction("sessions:keepalive");
    await runAction("work:route");
    await runAction("work:reap");
    await runAction("activities:deliver-due");
    expect((await outbound(agentSessionId)).length).toBe(count);
    expect((await itemsOf(agentSessionId)).length).toBe(1);

    // In Linear, no answer was posted, and nothing arrived after the cancel
    // settled.
    const after = await e2e.linearSession(externalSessionId, () => true);
    expect(
      after.activities.filter(
        (a) =>
          a.content.__typename === "AgentActivityResponseContent" ||
          a.content.__typename === "AgentActivityErrorContent",
      ),
    ).toEqual([]);
    expect(after.activities.length).toBe(settled.activities.length);
    expect(after.activities.length).toBeGreaterThanOrEqual(
      before.activities.length,
    );
  }, 60_000);
});
