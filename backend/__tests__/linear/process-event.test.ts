import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import {
  ackBody,
  QUEUED_BEHIND_BODY,
  STOPPED_BEFORE_START_BODY,
} from "../../ops/WorkItemOps";
import { agentSessions } from "../../schema/agent_sessions";
import { integrations } from "../../schema/integrations";
import { notifications } from "../../schema/notifications";
import { triggerEvents } from "../../schema/trigger_events";
import { workItems } from "../../schema/work_items";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import {
  agentSessionEvent,
  appUserNotification,
  deliver,
  permissionChange,
  type Target,
  webhookSession,
} from "./inject";
import {
  activityRows,
  createIssue,
  delegate,
  finearSession,
  recordedEvent,
  sessionRow,
  settle,
} from "./sessions";

/**
 * `triggers:process-event`: what each kind of Linear webhook does once it is
 * recorded. finear is the person and the workspace where it can be — delegating,
 * mentioning, prompting, stopping, commenting, un-delegating, uninstalling —
 * and a signed injected delivery where it cannot (permission changes,
 * notifications, structured context).
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

let target: Target;
let token: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  target = {
    organizationId: row.externalWorkspaceId,
    appUserId: row.externalAppUserId,
  };
  token = await appToken(universe.projectId);
}, HOOK_TIMEOUT);

/**
 * Delegate a fresh issue and wait for the mirror.
 * @param title - The issue's title.
 * @returns The issue and Linear's session id.
 */
async function delegated(title: string) {
  const issue = await createIssue(linear, title);
  const externalSessionId = await delegate(linear, issue.id, target.appUserId);
  await recordedEvent(
    (e) =>
      e.action === "created" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
  );
  await settle();
  const session = await sessionRow(externalSessionId);
  if (!session) throw new Error("no mirror row");
  return { issue, externalSessionId, session };
}

/** The thought a session gets when no rule matches it. */
const DEFAULT_ROUTING =
  "Routing as **worker** (no rule matched; worker is the default).";

/** What a session waits on when no runner exists at all. */
const NO_RUNNER =
  "Waiting for a runner: No runner in this project takes worker work to ENG.";

/**
 * A session's work items, oldest first.
 * @param agentSessionId - The session.
 * @returns The rows.
 */
async function itemsOf(agentSessionId: number) {
  return api.db.db
    .select()
    .from(workItems)
    .where(eq(workItems.agentSessionId, agentSessionId))
    .orderBy(workItems.id);
}

describe("AgentSessionEvent created", () => {
  test("LC-WH-12 a delegation mirrors the session, acknowledges it, queues its first turn, and says why it waits", async () => {
    const { issue, externalSessionId, session } =
      await delegated("Delegated issue");
    expect(session).toMatchObject({
      projectId: universe.projectId,
      externalIssueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: "Delegated issue",
      externalTeamId: FINEAR_FIXTURES.primary.team,
      teamKey: "ENG",
      origin: "delegation",
      creatorExternalUserId: FINEAR_FIXTURES.primary.user,
      creatorName: "Human 1",
      externalCommentId: null,
      promptContext: expect.stringContaining("Delegated issue"),
      role: "worker",
      repository: null,
      instruction: null,
      status: "active",
    });
    expect(session.endedAt).toBeNull();
    expect(session.issueSnapshot).toMatchObject({
      id: issue.id,
      identifier: issue.identifier,
      teamKey: "ENG",
      labels: [],
      parent: null,
    });

    const finear = await finearSession(linear, token, externalSessionId);
    expect(
      finear.activities.map((a) => [
        a.content.__typename,
        a.content.body,
        a.ephemeral,
      ]),
    ).toEqual([
      ["AgentActivityThoughtContent", ackBody(issue.identifier), false],
      ["AgentActivityThoughtContent", DEFAULT_ROUTING, false],
      ["AgentActivityThoughtContent", NO_RUNNER, true],
    ]);
    expect(finear.status).toBe("active");

    // LC-SES-15: the acknowledgement is a thought a person can read, not a
    // link — no session update has been sent before a runner claims.
    const rows = await activityRows(session.id);
    expect(
      rows.map((r) => [r.seq, r.direction, r.contentType, r.priority]),
    ).toEqual([
      [1, "outbound", "thought", "ack"],
      [2, "outbound", "thought", "normal"],
      [3, "outbound", "thought", "bulk"],
    ]);
    // Each row's client id is the id Linear holds.
    expect(finear.activities.map((a) => a.id)).toEqual(
      rows.map((r) => r.clientActivityId),
    );
    expect(rows.every((r) => r.deliveryStatus === "sent")).toBe(true);

    const [item] = await itemsOf(session.id);
    expect(item).toMatchObject({
      kind: "session_created",
      status: "queued",
      role: "worker",
      repositoryResolved: false,
      preferredUserId: null,
      waitingReason: NO_RUNNER,
    });
  });

  test("LC-WH-12 a mention in a child comment is origin mention, threaded, with previousComments", async () => {
    const issue = await createIssue(linear, "Mentioned issue");
    const root = await linear.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
      { input: { issueId: issue.id, body: "Root of the thread" } },
    );
    const rootId = root.data!.commentCreate.comment.id;
    const child = await linear.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
      {
        input: {
          issueId: issue.id,
          parentId: rootId,
          body: "@hypotenuse can you look?",
        },
      },
    );
    const childId = child.data!.commentCreate.comment.id;
    const mentioned = await linear.control<{ entity: { id: string } }>(
      "/__test/agents/mention",
      { issueId: issue.id, appUserId: target.appUserId, commentId: childId },
    );
    const externalSessionId = mentioned.entity.id;
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    await settle();

    const session = await sessionRow(externalSessionId);
    expect(session).toMatchObject({
      origin: "mention",
      externalCommentId: rootId,
      externalSourceCommentId: childId,
    });
    expect(session?.previousComments).toEqual([
      expect.objectContaining({ id: rootId, body: "Root of the thread" }),
    ]);
    expect(session?.instruction).toBe("@hypotenuse can you look?");
    const finear = await finearSession(linear, token, externalSessionId);
    expect(finear.activities.map((a) => a.content.body)).toEqual([
      ackBody(issue.identifier),
      DEFAULT_ROUTING,
      NO_RUNNER,
    ]);
  });

  test("LC-WH-12 promptContext and guidance are stored verbatim, and a replayed created acknowledges once", async () => {
    // finear sends neither a structured promptContext nor guidance.
    const issue = await createIssue(linear, "Guided issue");
    const promptContext =
      '<issue identifier="ENG-1"><title>Guided issue</title></issue><guidance>Use bun</guidance>';
    const guidance = [
      { body: "Use bun, never npm.", origin: { type: "Organization" } },
      {
        body: "Open PRs as drafts.",
        origin: {
          type: "Team",
          team: { id: FINEAR_FIXTURES.primary.team, key: "ENG", name: "Eng" },
        },
      },
    ];
    // A session finear knows, so the outbox has somewhere to write.
    const externalSessionId = await delegate(
      linear,
      issue.id,
      target.appUserId,
    );
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    const payload = agentSessionEvent(target, {
      action: "created",
      agentSession: webhookSession({
        id: externalSessionId,
        issueId: issue.id,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: "Guided issue",
          url: `https://linear.app/issue/${issue.identifier}`,
          teamId: FINEAR_FIXTURES.primary.team,
          team: { id: FINEAR_FIXTURES.primary.team, key: "ENG", name: "Eng" },
        },
      }),
      promptContext,
      guidance: guidance as never,
    });
    expect((await deliver(url, payload)).status).toBe(200);
    await settle();

    const session = await sessionRow(externalSessionId);
    expect(session?.promptContext).toBe(promptContext);
    expect(session?.guidance).toEqual(guidance);
    const rows = await activityRows(session!.id);
    expect(
      rows.filter(
        (r) =>
          (r.content as { body?: string }).body === ackBody(issue.identifier),
      ),
    ).toHaveLength(1);
    expect(await itemsOf(session!.id)).toHaveLength(1);
  });
});

describe("AgentSessionEvent prompted", () => {
  test("LC-WH-13 a follow-up prompt is recorded inbound and queued as the session's next turn", async () => {
    const { externalSessionId, session } = await delegated("Prompted issue");
    await linear.control("/__test/agents/prompt", {
      sessionId: externalSessionId,
      body: "Use the main branch",
    });
    await recordedEvent(
      (e) =>
        e.action === "prompted" &&
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
          externalSessionId,
    );
    await settle();

    const rows = await activityRows(session.id);
    const inbound = rows.find((r) => r.direction === "inbound");
    expect(inbound).toMatchObject({
      seq: 4,
      contentType: "prompt",
      content: { type: "prompt", body: "Use the main branch" },
      deliveryStatus: "received",
      signal: null,
      externalUserId: FINEAR_FIXTURES.primary.user,
    });
    expect(inbound?.externalActivityId).toBeTruthy();
    expect(inbound?.externalSourceCommentId).toBeTruthy();
    // The first turn has not started, so this one waits behind it, and says so.
    expect(rows.at(-1)).toMatchObject({
      seq: 5,
      direction: "outbound",
      contentType: "thought",
      content: { type: "thought", body: QUEUED_BEHIND_BODY },
      deliveryStatus: "sent",
    });
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status, i.role])).toEqual([
      ["session_created", "queued", "worker"],
      ["prompt", "queued", "worker"],
    ]);
    expect(items[1].prompt).toEqual([
      { activityId: inbound!.id, body: "Use the main branch" },
    ]);
    expect((await sessionRow(externalSessionId))?.status).toBe("active");
  });

  test("LC-WH-13 a stop is recorded with its signal and cancels the queued work, answering at once", async () => {
    const { externalSessionId, session } = await delegated("Stopped issue");
    await linear.control("/__test/agents/prompt", {
      sessionId: externalSessionId,
      body: "Try again",
    });
    await recordedEvent(
      (e) =>
        e.action === "prompted" &&
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
          externalSessionId,
    );
    await settle();
    await linear.control("/__test/agents/stop", {
      sessionId: externalSessionId,
    });
    await recordedEvent(
      (e) =>
        e.action === "prompted" &&
        (e.payload as { agentActivity?: { signal?: string } }).agentActivity
          ?.signal === "stop",
    );
    await settle();

    const rows = await activityRows(session.id);
    const stop = rows.find((r) => r.signal === "stop");
    expect(stop).toMatchObject({ direction: "inbound", contentType: "prompt" });
    expect(rows.at(-1)).toMatchObject({
      direction: "outbound",
      contentType: "response",
      content: { type: "response", body: STOPPED_BEFORE_START_BODY },
      priority: "ack",
      deliveryStatus: "sent",
    });
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([
      ["cancelled", "stop"],
      ["cancelled", "superseded"],
    ]);
    const finear = await finearSession(linear, token, externalSessionId);
    expect(finear.status).toBe("complete");
    expect((await sessionRow(externalSessionId))?.status).toBe("complete");
  });

  test("LC-DIFF-01 the prompt body is read from content.body or, as the docs say, body", async () => {
    const { externalSessionId, session } = await delegated("Two shapes");
    const prompted = (activity: Record<string, unknown>) =>
      agentSessionEvent(target, {
        action: "prompted",
        agentSession: webhookSession({
          id: externalSessionId,
          status: "pending",
        }),
        agentActivity: {
          id: crypto.randomUUID(),
          agentSessionId: externalSessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: FINEAR_FIXTURES.primary.user,
          user: {
            id: FINEAR_FIXTURES.primary.user,
            name: "Human 1",
            email: "human1@example.com",
            url: "https://linear.app",
          },
          content: {},
          ...activity,
        },
      });
    await deliver(
      url,
      prompted({ content: { type: "prompt", body: "from the schema" } }),
    );
    await deliver(url, prompted({ body: "from the docs" }));
    await settle();

    const bodies = (await activityRows(session.id))
      .filter((r) => r.direction === "inbound")
      .map((r) => (r.content as { body: string }).body);
    expect(bodies).toEqual(["from the schema", "from the docs"]);
  });
});

describe("other events", () => {
  test("LC-WH-20 LC-OAUTH-25 a team-access change updates the integration and ends sessions on removed teams", async () => {
    const { session } = await delegated("On a team about to be removed");
    const before = await integrationRow(universe.projectId);
    const added = FINEAR_FIXTURES.primary.privateTeam;
    const res = await deliver(
      url,
      permissionChange(target, {
        addedTeamIds: [added],
        removedTeamIds: [FINEAR_FIXTURES.primary.team],
        canAccessAllPublicTeams: false,
      }),
    );
    expect(res.status).toBe(200);
    await settle();

    const after = await integrationRow(universe.projectId);
    expect(after.details.teamIds).toContain(added);
    expect(after.details.teamIds).not.toContain(FINEAR_FIXTURES.primary.team);
    expect(after.details.canAccessAllPublicTeams).toBe(false);
    expect((await sessionRow(session.externalSessionId))?.status).toBe("error");
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([["cancelled", "integration_revoked"]]);
    const [event] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.eventType, "PermissionChange"));
    expect(event.outcome).toBe("handled");

    // Put it back for the rest of the file.
    await api.db.db
      .update(integrations)
      .set({ details: before.details })
      .where(eq(integrations.id, before.id));
  });

  test("LC-WH-24 a comment is recorded and ignored", async () => {
    const issue = await createIssue(linear, "Commented issue");
    await linear.graphql(
      FINEAR_PRIMARY_KEY,
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: issue.id, body: "Just a comment" } },
    );
    const event = await recordedEvent((e) => e.eventType === "Comment");
    await settle();
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.id, event.id));
    expect(row.outcome).toBe("ignored");
  });

  test("LC-WH-22 an OAuthAuthorization and an unknown type are recorded and ignored", async () => {
    for (const type of ["OAuthAuthorization", "Reaction"]) {
      const res = await deliver(url, {
        type,
        action: "create",
        organizationId: target.organizationId,
        createdAt: new Date().toISOString(),
        webhookTimestamp: Date.now(),
      });
      expect(res.status).toBe(200);
    }
    await settle();
    const rows = await api.db.db.select().from(triggerEvents);
    for (const type of ["OAuthAuthorization", "Reaction"]) {
      expect(rows.find((r) => r.eventType === type)?.outcome).toBe("ignored");
    }
  });

  test("LC-BP-08 an AppUserNotification is recorded as noted and starts nothing", async () => {
    const sessionsBefore = await api.db.db.select().from(agentSessions);
    const res = await deliver(url, appUserNotification(target, "issueMention"));
    expect(res.status).toBe(200);
    await settle();
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.eventType, "AppUserNotification"));
    expect(row.outcome).toBe("noted");
    expect(await api.db.db.select().from(agentSessions)).toHaveLength(
      sessionsBefore.length,
    );
  });

  test("LC-WH-23 removing the app as delegate records it on the issue's sessions and quietly cancels their work", async () => {
    const { issue, session } = await delegated("Un-delegated issue");
    expect(session.delegateRemovedAt).toBeNull();
    await linear.graphql(
      FINEAR_PRIMARY_KEY,
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { delegateId: null } },
    );
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        e.action === "update" &&
        (e.payload as { updatedFrom?: { delegateId?: string } }).updatedFrom
          ?.delegateId === target.appUserId,
    );
    await settle();
    expect(
      (await sessionRow(session.externalSessionId))?.delegateRemovedAt,
    ).not.toBeNull();
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([["cancelled", "delegate_removed"]]);
    // A person disengaged: nothing more is said.
    expect((await activityRows(session.id)).at(-1)?.contentType).toBe(
      "thought",
    );
  });

  test("LC-WH-21 uninstalling the app in Linear revokes the integration, fails its outbox, and tells the admins", async () => {
    // A session with an unsent row, so there is something to fail.
    const { session } = await delegated("Before the uninstall");
    await api.db.db.transaction(async (tx) => {
      const { enqueueActivity } = await import("../../ops/ActivityOutboxOps");
      await enqueueActivity(tx, session.id, {
        type: "thought",
        body: "never sent",
      });
    });

    // Revoking an actor=app token uninstalls the app; finear then sends
    // `OAuthApp` / `revoked`.
    const revoked = await fetch(`${linear.url()}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(revoked.status).toBe(200);
    await recordedEvent((e) => e.eventType === "OAuthApp");
    await settle();

    const row = await integrationRow(universe.projectId);
    expect(row.status).toBe("revoked");
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
    const rows = await activityRows(session.id);
    expect(rows.at(-1)).toMatchObject({
      deliveryStatus: "failed",
      lastError: "integration unavailable",
    });
    expect(
      (await itemsOf(session.id)).map((i) => [i.status, i.cancelReason]),
    ).toEqual([["cancelled", "integration_revoked"]]);
    const sent = await api.db.db
      .select()
      .from(notifications)
      .where(eq(notifications.template, "linear-revoked"));
    expect(new Set(sent.map((n) => n.userId))).toEqual(
      new Set([universe.peach.userId]),
    );

    // From now on the workspace routes nowhere, and is still answered 200.
    const after = await deliver(
      url,
      agentSessionEvent(target, {
        action: "created",
        agentSession: webhookSession(),
      }),
    );
    expect(after.status).toBe(200);
    const [unknown] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, after.deliveryId!));
    expect(unknown.outcome).toBe("unknown_integration");
  });
});
