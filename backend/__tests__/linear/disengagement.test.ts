import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cancel } from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import {
  delegatedSession,
  itemRow,
  itemsOf,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import { activityRows, finearSession, recordedEvent, settle } from "./sessions";

/**
 * Disengagement: a person un-delegating the issue, closing it, or deleting it
 * cancels the live turn — and from then on nothing reaches Linear for it. The
 * daemon is told with the reason; anything it still sends is dropped, and the
 * server posts no fallback answer when the turn ends.
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
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
    { limits: { maxParallelJobs: 8 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * A delegated session whose turn the laptop is running, a thought posted.
 * @param title - The issue title.
 * @returns The issue, session, and work item.
 */
async function running(title: string) {
  const { issue, session, externalSessionId } = await delegatedSession(
    linear,
    appUserId,
    title,
  );
  const [first] = await itemsOf(session.id);
  if (first.status !== "offered") await route();
  const assignment = await laptop.claim([first.id]);
  if (!assignment) throw new Error("not claimed");
  await laptop.events(first.id, [{ type: "thought", body: "Working on it" }]);
  await settle();
  expect((await itemRow(first.id)).status).toBe("running");
  return {
    issue,
    session,
    externalSessionId,
    workItemId: first.id,
    deleted: false,
  };
}

/**
 * Update an issue in finear as Human 1.
 * @param id - The issue.
 * @param input - The fields.
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

/**
 * After the disengagement: the daemon is told why, whatever it still sends
 * is dropped, its completion posts nothing, and the last activity in Linear
 * is still the turn's own (unless the issue, and its session, are gone).
 * @param s - The running turn.
 * @param reason - The cancel reason expected.
 */
async function quietlyCancelled(
  s: Awaited<ReturnType<typeof running>>,
  reason: Cancel["reason"],
): Promise<void> {
  const beat = await laptop.heartbeat();
  expect(beat.cancels).toContainEqual({ workItemId: s.workItemId, reason });
  const late = await laptop.events(s.workItemId, [
    { type: "thought", body: "Still going" },
    { type: "response", body: "Stopped." },
  ]);
  expect(late.body).toMatchObject({
    accepted: 0,
    dropped: 2,
    cancelRequested: true,
  });
  await laptop.complete(s.workItemId, "cancelled");
  await settle();
  expect(await itemRow(s.workItemId)).toMatchObject({
    status: "cancelled",
    cancelReason: reason,
  });
  if (s.deleted) return;
  const after = await finearSession(linear, token, s.externalSessionId);
  expect(after.activities.at(-1)?.content.body).toBe("Working on it");
}

describe("LC-WH-23 disengagement through Issue webhooks", () => {
  test("LC-SES-20 un-delegating the issue (as dismissing the session does) cancels the turn quietly (delegate_removed)", async () => {
    const s = await running("Un-delegate me");
    await updateIssue(s.issue.id, { delegateId: null });
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { updatedFrom?: { delegateId?: string } }).updatedFrom
          ?.delegateId === appUserId,
    );
    await settle();
    await quietlyCancelled(s, "delegate_removed");
  });

  test("moving the issue to a completed state cancels the turn quietly (issue_closed)", async () => {
    const s = await running("Close me");
    await updateIssue(s.issue.id, {
      stateId: FINEAR_FIXTURES.primary.completed,
    });
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { id?: string; state?: { type?: string } } })
          .data?.state?.type === "completed" &&
        (e.payload as { data?: { id?: string } }).data?.id === s.issue.id,
    );
    await settle();
    await quietlyCancelled(s, "issue_closed");
  });

  test("deleting the issue cancels the turn quietly (issue_closed)", async () => {
    const s = await running("Delete me");
    const reply = await linear.graphql(
      FINEAR_PRIMARY_KEY,
      "mutation($id: String!) { issueDelete(id: $id) { success } }",
      { id: s.issue.id },
    );
    if (reply.errors) throw new Error(JSON.stringify(reply.errors));
    s.deleted = true;
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        e.action === "remove" &&
        (e.payload as { data?: { id?: string } }).data?.id === s.issue.id,
    );
    await settle();
    await quietlyCancelled(s, "issue_closed");
  });

  test("other issue changes (a title, a move to started) leave the turn alone", async () => {
    const s = await running("Rename me");
    await updateIssue(s.issue.id, {
      title: "Renamed",
      stateId: FINEAR_FIXTURES.primary.started,
    });
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { title?: string } }).data?.title === "Renamed",
    );
    await settle();
    expect((await itemRow(s.workItemId)).status).toBe("running");
    await laptop.complete(s.workItemId, "completed");
  });

  test("LC-AIG-05 after a disengagement nothing on the server re-engages: no routing, keepalive, or retry makes work or speaks", async () => {
    const s = await running("Leave me be");
    await updateIssue(s.issue.id, { delegateId: null });
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { id?: string } }).data?.id === s.issue.id &&
        (e.payload as { updatedFrom?: { delegateId?: string } }).updatedFrom
          ?.delegateId === appUserId,
    );
    await settle();
    await quietlyCancelled(s, "delegate_removed");
    const items = (await itemsOf(s.session.id)).length;
    const outbound = (await activityRows(s.session.id)).filter(
      (r) => r.direction === "outbound",
    ).length;
    // Every server-originated path, with time moved past their thresholds.
    await api.db.db
      .update(agentSessions)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(agentSessions.id, s.session.id));
    await runAction("sessions:keepalive");
    await route();
    await runAction("work:reap");
    await laptop.heartbeat();
    await settle();
    expect((await itemsOf(s.session.id)).length).toBe(items);
    expect(
      (await activityRows(s.session.id)).filter(
        (r) => r.direction === "outbound",
      ).length,
    ).toBe(outbound);
  });
});
