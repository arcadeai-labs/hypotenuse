import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { checkNotification } from "../../ops/LinearNotificationOps";
import { agentSessions } from "../../schema/agent_sessions";
import { type TriggerEvent, triggerEvents } from "../../schema/trigger_events";
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
import { appUserNotification, deliver, type Target } from "./inject";
import { createIssue, finearSession, recordedEvent, settle } from "./sessions";

/**
 * `AppUserNotification`: every inbox notification type has a decided
 * handling, visible as the delivery's outcome. Sessions start work;
 * notifications never do — but an unassignment, or a person closing the
 * issue, ends live work as a disengagement, quietly.
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

let target: Target;
let token: string;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  target = {
    organizationId: row.externalWorkspaceId,
    appUserId: row.externalAppUserId,
  };
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
 * Deliver one notification and process it.
 * @param action - The notification type.
 * @param fields - Notification fields.
 * @returns The recorded delivery, processed.
 */
async function notify(
  action: string,
  fields: Record<string, unknown> = {},
): Promise<TriggerEvent> {
  const res = await deliver(
    universe.url,
    appUserNotification(target, action, fields),
  );
  expect(res.status).toBe(200);
  await settle();
  const [row] = await api.db.db
    .select()
    .from(triggerEvents)
    .where(eq(triggerEvents.deliveryId, res.deliveryId as string));
  return row;
}

/**
 * Make a processed notification's check due, and run the clock.
 * @param eventId - The delivery.
 * @returns The delivery after the check.
 */
async function checkNow(eventId: number): Promise<TriggerEvent> {
  await api.db.db
    .update(triggerEvents)
    .set({ checkAfter: new Date(Date.now() - 1000) })
    .where(eq(triggerEvents.id, eventId));
  await runAction("triggers:check-notifications");
  await settle();
  const [row] = await api.db.db
    .select()
    .from(triggerEvents)
    .where(eq(triggerEvents.id, eventId));
  return row;
}

/**
 * A delegated session whose turn the laptop is running.
 * @param title - The issue title.
 * @returns The issue, session, and work item.
 */
async function running(title: string) {
  const s = await delegatedSession(linear, target.appUserId, title);
  const [first] = await itemsOf(s.session.id);
  if (first.status !== "offered") await route();
  if (!(await laptop.claim([first.id]))) throw new Error("not claimed");
  await laptop.events(first.id, [{ type: "thought", body: "Working on it" }]);
  await settle();
  return { ...s, workItemId: first.id };
}

/**
 * The turn was cancelled for this reason, the daemon was told, and nothing
 * more reached Linear.
 * @param s - The running turn.
 * @param reason - The cancel reason.
 */
async function quietlyCancelled(
  s: Awaited<ReturnType<typeof running>>,
  reason: string,
): Promise<void> {
  const beat = await laptop.heartbeat();
  expect(beat.cancels).toContainEqual({ workItemId: s.workItemId, reason });
  await laptop.complete(s.workItemId, "cancelled");
  await settle();
  expect(await itemRow(s.workItemId)).toMatchObject({
    status: "cancelled",
    cancelReason: reason,
  });
  const after = await finearSession(linear, token, s.externalSessionId);
  expect(after.activities.at(-1)?.content.body).toBe("Working on it");
}

describe("LC-WH-16 mentions", () => {
  test("a mention a session followed stays noted", async () => {
    const s = await delegatedSession(linear, target.appUserId, "Mentioned");
    const event = await notify("issueMention", { issueId: s.issue.id });
    expect(event.outcome).toBe("noted");
    expect(event.checkAfter).not.toBeNull();
    const checked = await checkNow(event.id);
    expect(checked).toMatchObject({ outcome: "noted", checkAfter: null });
  });

  test("a comment mention no session followed is recorded as mention_without_session", async () => {
    const issue = await createIssue(linear, "Mentioned, nobody came");
    const event = await notify("issueCommentMention", { issueId: issue.id });
    expect(event.outcome).toBe("noted");
    const checked = await checkNow(event.id);
    expect(checked).toMatchObject({
      outcome: "mention_without_session",
      checkAfter: null,
    });
  });

  test("a check that is not yet due does nothing", async () => {
    const issue = await createIssue(linear, "Not yet");
    const event = await notify("issueMention", { issueId: issue.id });
    await runAction("triggers:check-notifications");
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.id, event.id));
    expect(row.outcome).toBe("noted");
    expect(row.checkAfter).not.toBeNull();
  });
});

describe("LC-WH-17 assignment", () => {
  test("an assignment starts nothing and is recorded as assigned_not_delegated", async () => {
    const issue = await createIssue(linear, "Assigned, not delegated");
    const sessionsBefore = await api.db.db.select().from(agentSessions);
    const event = await notify("issueAssignedToYou", { issueId: issue.id });
    expect(event.outcome).toBe("assigned_not_delegated");
    expect(await api.db.db.select().from(agentSessions)).toHaveLength(
      sessionsBefore.length,
    );
  });

  test("an unassignment cancels the issue's live turn quietly (unassigned)", async () => {
    const s = await running("Unassign me");
    const event = await notify("issueUnassignedFromYou", {
      issueId: s.issue.id,
    });
    expect(event.outcome).toBe("disengaged");
    await quietlyCancelled(s, "unassigned");
  });

  test("an unassignment with nothing live is noted", async () => {
    const issue = await createIssue(linear, "Unassigned, idle");
    const event = await notify("issueUnassignedFromYou", {
      issueId: issue.id,
    });
    expect(event.outcome).toBe("noted");
  });
});

describe("LC-WH-18 reactions and comments", () => {
  test("reactions and new comments are recorded and ignored", async () => {
    const issue = await createIssue(linear, "Reacted to");
    for (const action of [
      "issueEmojiReaction",
      "issueCommentReaction",
      "issueNewComment",
    ]) {
      const event = await notify(action, { issueId: issue.id });
      expect(event.outcome, action).toBe("ignored");
      expect(event.checkAfter).toBeNull();
    }
  });
});

describe("LC-WH-19 status changes and other types", () => {
  test("a person closing the issue mid-turn disengages it once the clock reads the state", async () => {
    const s = await running("Close me from the inbox");
    // The issue is closed in Linear; the `Issue` webhook is left unprocessed
    // so the notification alone must find out.
    await linear.graphql(
      FINEAR_PRIMARY_KEY,
      "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      { id: s.issue.id, input: { stateId: FINEAR_FIXTURES.primary.completed } },
    );
    const issueEvent = await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { id?: string } }).data?.id === s.issue.id,
    );
    await api.db.db
      .update(triggerEvents)
      .set({ processedAt: new Date(), outcome: "ignored" })
      .where(eq(triggerEvents.id, issueEvent.id));

    const event = await notify("issueStatusChanged", {
      issueId: s.issue.id,
      actorId: "a-person",
    });
    expect(event.outcome).toBe("noted");
    const checked = await checkNow(event.id);
    expect(checked.outcome).toBe("disengaged");
    await quietlyCancelled(s, "issue_closed");
  });

  test("two clock ticks reaching one due check: exactly one does it", async () => {
    const s = await running("Checked once");
    const event = await notify("issueStatusChanged", {
      issueId: s.issue.id,
      actorId: "a-person",
    });
    await api.db.db
      .update(triggerEvents)
      .set({ checkAfter: new Date(Date.now() - 1000) })
      .where(eq(triggerEvents.id, event.id));
    const results = await Promise.all([
      checkNotification(event.id),
      checkNotification(event.id),
    ]);
    expect(results.sort()).toEqual(["skipped", "still_open"]);
    expect((await itemRow(s.workItemId)).status).toBe("running");
    await laptop.complete(s.workItemId, "completed");
    await settle();
  });

  test("a status change to an open state leaves the turn running", async () => {
    const s = await running("Still open");
    const event = await notify("issueStatusChanged", {
      issueId: s.issue.id,
      actorId: "a-person",
    });
    const checked = await checkNow(event.id);
    expect(checked.outcome).toBe("ignored");
    expect((await itemRow(s.workItemId)).status).toBe("running");
    await laptop.complete(s.workItemId, "completed");
  });

  test("a status change by the app itself, or with nothing live, is ignored", async () => {
    const s = await running("Moved by the app");
    const own = await notify("issueStatusChanged", {
      issueId: s.issue.id,
      actorId: target.appUserId,
    });
    expect(own).toMatchObject({ outcome: "ignored", checkAfter: null });
    await laptop.complete(s.workItemId, "completed");
    await settle();
    const idle = await notify("issueStatusChanged", {
      issueId: s.issue.id,
      actorId: "a-person",
    });
    expect(idle).toMatchObject({ outcome: "ignored", checkAfter: null });
  });

  test("LC-BP-08 every other notification type is recorded and ignored", async () => {
    for (const action of [
      "agentConversationMention",
      "documentMention",
      "projectMention",
      "issueReopened",
      "pullRequestReviewRequested",
    ]) {
      const event = await notify(action);
      expect(event.outcome, action).toBe("ignored");
    }
  });
});
