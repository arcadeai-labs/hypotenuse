import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { checkNotification } from "../../ops/LinearNotificationOps";
import { NO_ISSUE_RESPONSE } from "../../ops/LinearWebhookOps";
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
import {
  agentSessionEvent,
  appUserNotification,
  deliver,
  type Target,
  webhookSession,
} from "./inject";
import {
  activityRows,
  createIssue,
  finearSession,
  recordedEvent,
  settle,
  waitFor,
} from "./sessions";

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

describe("LC-WH-26 project comment mentions", () => {
  /**
   * A project in finear, on the primary team.
   * @param name - Its name.
   * @returns Its id, name, and URL.
   */
  async function project(name: string) {
    const made = await linear.graphql<{
      projectCreate: { project: { id: string; name: string; url: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id name url } } }`,
      { input: { name, teamIds: [FINEAR_FIXTURES.primary.team] } },
    );
    if (!made.data) throw new Error(JSON.stringify(made.errors));
    return made.data.projectCreate.project;
  }

  /**
   * A person's `projectCommentMention` on a project.
   * @param p - The project.
   * @param body - The comment.
   * @returns The recorded delivery.
   */
  function mentionOn(
    p: Awaited<ReturnType<typeof project>>,
    body: string,
  ): Promise<TriggerEvent> {
    const commentId = crypto.randomUUID();
    return notify("projectCommentMention", {
      actorId: FINEAR_FIXTURES.primary.user,
      actor: {
        id: FINEAR_FIXTURES.primary.user,
        name: "Human 1",
        email: "human1@example.com",
      },
      commentId,
      comment: { id: commentId, body, projectId: p.id },
      projectId: p.id,
      project: p,
    });
  }

  /**
   * The requests the proxy saw for one operation.
   * @param operation - Its name.
   * @returns Their variables.
   */
  const sent = (operation: string) =>
    linear
      .requests()
      .filter((r) => r.operationName === operation)
      .map((r) => r.variables);

  test("LC-WH-26 a person's mention files [hypotenuse] Plan: <project>, starts a manager session on it with the comment's text, and replies with the link", async () => {
    const poems = await project("Poems");
    const event = await mentionOn(poems, "@hypotenuse /manage plan the poems");
    expect(event).toMatchObject({ outcome: "noted" });
    expect(event.checkAfter).not.toBeNull();
    linear.clearRequests();
    const checked = await checkNow(event.id);

    const [filed] = sent("CreateIssue") as {
      input: Record<string, string>;
    }[];
    expect(filed.input).toMatchObject({
      teamId: FINEAR_FIXTURES.primary.team,
      projectId: poems.id,
      title: "[hypotenuse] Plan: Poems",
    });
    expect(filed.input.description).toStartWith("plan the poems\n\n---\n\n");
    expect(sent("CreateAgentSessionOnIssue")).toHaveLength(1);
    expect(sent("CreateComment")).toEqual([
      {
        input: {
          projectId: poems.id,
          parentId: (event.payload.notification as { commentId: string })
            .commentId,
          body: expect.stringMatching(/^Planning this project in \[/),
        },
      },
    ]);
    // finear holds comments on issues only, so its reply is refused; the
    // planning goes ahead. A refusal of anything stays `noted`.
    expect(checked).toMatchObject({ outcome: "noted", checkAfter: null });
    expect(checked.summary).toMatch(
      /^Filed [A-Z]+-\d+ and started a manager session on it; the reply on the project comment failed\.$/,
    );

    // Linear's `created` for the session makes it a manager, before routing.
    // finear delivers it on its own schedule; settle until it is processed.
    const session = await waitFor(async () => {
      await settle();
      const [row] = await api.db.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.issueTitle, "[hypotenuse] Plan: Poems"));
      return row;
    });
    expect(session).toMatchObject({
      role: "manager",
      routingRuleName: "project mention",
      instruction: "plan the poems",
      creatorExternalUserId: FINEAR_FIXTURES.primary.user,
    });
    const [first] = await itemsOf(session.id);
    expect(first).toMatchObject({ kind: "session_created", role: "manager" });
  }, 20_000);

  test("a lost answer is retried without filing a second issue or starting a second session", async () => {
    const odes = await project("Odes");
    const event = await mentionOn(odes, "@hypotenuse plan the odes");
    linear.clearRequests();
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "CreateAgentSessionOnIssue",
    });
    const first = await checkNow(event.id);
    expect(first.outcome).toBe("noted");
    expect(first.checkAfter).not.toBeNull();
    // finear did start the session. The retry comes a minute later; by then
    // its `created` is mirrored.
    await waitFor(async () => {
      await settle();
      const [row] = await api.db.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.issueTitle, "[hypotenuse] Plan: Odes"));
      return row;
    });
    const second = await checkNow(event.id);
    expect(sent("CreateIssue")).toHaveLength(1);
    expect(sent("CreateAgentSessionOnIssue")).toHaveLength(1);
    expect(second.summary).toMatch(
      /^Filed [A-Z]+-\d+; Linear had already started its session\.$/,
    );
    const sessions = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.issueTitle, "[hypotenuse] Plan: Odes"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].role).toBe("manager");
  }, 20_000);

  test("a project with no team is refused, still noted", async () => {
    const event = await notify("projectCommentMention", {
      actorId: FINEAR_FIXTURES.primary.user,
      commentId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
    });
    const checked = await checkNow(event.id);
    expect(checked).toMatchObject({ outcome: "noted", checkAfter: null });
    expect(checked.summary).toStartWith(
      "Linear refused planning the project: ",
    );
  });

  test("a project comment mention by the app itself, or with no comment, is ignored", async () => {
    const own = await notify("projectCommentMention", {
      actorId: target.appUserId,
      commentId: crypto.randomUUID(),
    });
    const none = await notify("projectCommentMention", {
      actorId: crypto.randomUUID(),
    });
    for (const event of [own, none]) {
      expect(event).toMatchObject({ outcome: "ignored", checkAfter: null });
    }
  });

  test("a session with no issue is answered on created and on each prompt, and no turn is queued", async () => {
    const session = webhookSession({
      issueId: undefined,
      issue: undefined,
      commentId: crypto.randomUUID(),
    });
    const created = await deliver(
      universe.url,
      agentSessionEvent(target, { action: "created", agentSession: session }),
    );
    expect(created.status).toBe(200);
    await settle();
    const [event] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, created.deliveryId as string));
    expect(event).toMatchObject({
      outcome: "handled",
      summary:
        "A session with no issue (started on a project comment): answered that work starts from an issue; no turn queued.",
    });
    const [row] = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.externalSessionId, session.id));
    expect(row.externalIssueId).toBe("");

    const prompted = await deliver(
      universe.url,
      agentSessionEvent(target, {
        action: "prompted",
        agentSession: session,
        agentActivity: {
          id: crypto.randomUUID(),
          agentSessionId: session.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: FINEAR_FIXTURES.primary.user,
          content: { type: "prompt", body: "please?" },
        } as never,
      }),
    );
    expect(prompted.status).toBe(200);
    await settle();
    const outbound = (await activityRows(row.id)).filter(
      (a) => a.direction === "outbound",
    );
    expect(outbound.map((a) => [a.contentType, a.content.body])).toEqual([
      ["response", NO_ISSUE_RESPONSE],
      ["response", NO_ISSUE_RESPONSE],
    ]);
    expect(await itemsOf(row.id)).toEqual([]);
  });
});
