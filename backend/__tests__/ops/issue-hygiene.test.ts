import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import {
  FINEAR_FIXTURES,
  FINEAR_PRIMARY_KEY,
  useFinear,
} from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  activityRows,
  createIssue,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  delegatedSession,
  itemRow,
  itemsOf,
  route,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";

/**
 * Issue hygiene at claim, against finear: a person's delegation moves the
 * issue to the team's first started state; an automation's, a mention, an
 * already-started issue, and a manager are left alone; a missing delegate is
 * set; the assignee is never touched; a failure is a thought, not a failed
 * claim.
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
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
    { limits: { maxParallelJobs: 8 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/** An issue's hygiene-relevant fields, as finear has them. */
interface IssueNow {
  state: { id: string; type: string; name: string };
  delegate: { id: string } | null;
  assignee: { id: string } | null;
}

/**
 * Read an issue from finear as Human 1.
 * @param id - The issue.
 * @returns Its state, delegate, and assignee.
 */
async function issueNow(id: string): Promise<IssueNow> {
  const reply = await linear.graphql<{ issue: IssueNow }>(
    FINEAR_PRIMARY_KEY,
    "query($id: String!) { issue(id: $id) { state { id type name } delegate { id } assignee { id } } }",
    { id },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.issue;
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
 * Claim a session's first turn as the laptop.
 * @param agentSessionId - The session.
 * @returns The claimed item, re-read.
 */
async function claimFirst(agentSessionId: number) {
  const [item] = await itemsOf(agentSessionId);
  if (item.status !== "offered") await route();
  const assignment = await laptop.claim([item.id]);
  expect(assignment?.workItemId).toBe(item.id);
  await settle();
  return itemRow(item.id);
}

describe("the started-state move", () => {
  test("LC-DEL-02 LC-BP-04 a person's delegation from backlog moves the issue to the team's first started state", async () => {
    const { issue, session } = await delegatedSession(
      linear,
      appUserId,
      "Move me",
    );
    expect((await issueNow(issue.id)).state.type).not.toBe("started");
    const item = await claimFirst(session.id);
    const now = await issueNow(issue.id);
    expect(now.state).toMatchObject({
      id: FINEAR_FIXTURES.primary.started,
      type: "started",
    });
    expect(item.hygiene?.state).toEqual({
      outcome: "moved",
      detail: now.state.name,
    });
    // The move is our own Issue webhook: recorded, ignored, nothing cancelled.
    await recordedEvent(
      (e) =>
        e.eventType === "Issue" &&
        (e.payload as { data?: { id?: string; state?: { type?: string } } })
          .data?.id === issue.id &&
        (e.payload as { data?: { state?: { type?: string } } }).data?.state
          ?.type === "started",
    );
    await settle();
    expect((await itemRow(item.id)).status).toBe("claimed");
    await laptop.complete(item.id, "completed");
  });

  test("an issue already started is left as it is", async () => {
    const created = await createIssue(linear, "Already going");
    await updateIssue(created.id, { stateId: FINEAR_FIXTURES.primary.started });
    const before = await issueNow(created.id);
    const { session } = await delegatedFrom(created.id);
    const item = await claimFirst(session.id);
    expect(item.hygiene?.state).toEqual({
      outcome: "unchanged",
      detail: `already started (${before.state.name})`,
    });
    expect((await issueNow(created.id)).state.id).toBe(before.state.id);
    await laptop.complete(item.id, "completed");
  });

  test("LC-DEL-03 LC-BP-05 a session an automation started (no creator) leaves triage to a person", async () => {
    const { issue, session } = await delegatedSession(
      linear,
      appUserId,
      "Automated",
    );
    // finear cannot start a session without a person; the mirror is told so.
    await api.db.db
      .update(agentSessions)
      .set({
        creatorExternalUserId: null,
        creatorName: null,
        creatorEmail: null,
      })
      .where(eq(agentSessions.id, session.id));
    const before = await issueNow(issue.id);
    const item = await claimFirst(session.id);
    expect(item.hygiene?.state).toEqual({
      outcome: "skipped",
      detail: "started by an automation",
    });
    expect((await issueNow(issue.id)).state.id).toBe(before.state.id);
    await laptop.complete(item.id, "completed");
  });

  test("a manager session changes nothing", async () => {
    const { issue, session } = await delegatedSession(
      linear,
      appUserId,
      "Plan it",
    );
    const [first] = await itemsOf(session.id);
    await setItem(first.id, { role: "manager" });
    const before = await issueNow(issue.id);
    const item = await claimFirst(session.id);
    expect(item.hygiene).toMatchObject({
      state: { outcome: "skipped", detail: "manager role" },
      delegate: { outcome: "skipped", detail: "manager role" },
    });
    expect(await issueNow(issue.id)).toEqual(before);
    await laptop.complete(item.id, "completed");
  });
});

describe("the delegate", () => {
  test("LC-DEL-04 a mention on an issue with no delegate sets the app as delegate, and leaves the state alone", async () => {
    const created = await createIssue(linear, "Mention me");
    const comment = await linear.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }",
      { input: { issueId: created.id, body: "@hypotenuse can you fix this?" } },
    );
    const result = await linear.control<{ entity: { id: string } }>(
      "/__test/agents/mention",
      {
        issueId: created.id,
        appUserId,
        commentId: comment.data?.commentCreate.comment.id,
      },
    );
    await recordedEvent(
      (e) =>
        e.action === "created" &&
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
          result.entity.id,
    );
    await settle();
    const session = await sessionRow(result.entity.id);
    if (!session) throw new Error("no mirror row");
    expect(session.origin).toBe("mention");
    const before = await issueNow(created.id);
    expect(before.delegate).toBeNull();
    const item = await claimFirst(session.id);
    const now = await issueNow(created.id);
    expect(now.delegate?.id).toBe(appUserId);
    expect(now.state.id).toBe(before.state.id);
    expect(item.hygiene).toMatchObject({
      state: { outcome: "skipped", detail: "not a delegation" },
      delegate: { outcome: "set", detail: "delegated to the app" },
    });
    // Setting the delegate reused the live session: no second one.
    await settle();
    expect(await itemsOf(session.id)).toHaveLength(1);
    await laptop.complete(item.id, "completed");
  });

  test("the assignee is never changed", async () => {
    const created = await createIssue(linear, "Owned by a person");
    await updateIssue(created.id, { assigneeId: FINEAR_FIXTURES.primary.user });
    const { session } = await delegatedFrom(created.id);
    const item = await claimFirst(session.id);
    const now = await issueNow(created.id);
    expect(now.assignee?.id).toBe(FINEAR_FIXTURES.primary.user);
    expect(now.delegate?.id).toBe(appUserId);
    expect(item.hygiene?.delegate).toEqual({
      outcome: "unchanged",
      detail: "already delegated to the app",
    });
    await laptop.complete(item.id, "completed");
  });
});

describe("failures and repeats", () => {
  test("hygiene runs once: a repeated claim does not redo it", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Twice");
    const item = await claimFirst(session.id);
    const at = item.hygiene?.at;
    linear.clearRequests();
    await laptop.claim([item.id]);
    expect((await itemRow(item.id)).hygiene?.at).toBe(at);
    expect(
      linear.requests().filter((r) => r.operationName === "UpdateIssue"),
    ).toHaveLength(0);
    await laptop.complete(item.id, "completed");
  });

  test("a Linear refusal (rate limited) is a thought on the session, and the claim still succeeds", async () => {
    const { issue, session } = await delegatedSession(
      linear,
      appUserId,
      "Refuse me",
    );
    linear.fault({
      kind: "ratelimit",
      match: (r) => r.operationName === "GetIssue",
    });
    const item = await claimFirst(session.id);
    expect(item.status).toBe("claimed");
    expect(item.hygiene?.state.outcome).toBe("failed");
    const thought = (await activityRows(session.id)).find(
      (r) =>
        r.contentType === "thought" &&
        String((r.content as { body?: string }).body).startsWith(
          "Could not read",
        ),
    );
    expect(thought).toBeDefined();
    expect((await issueNow(issue.id)).state.type).not.toBe("started");
    await laptop.complete(item.id, "completed");
  });
});

/**
 * Delegate an existing issue to the app and settle the session.
 * @param issueId - The issue.
 * @returns The mirror row.
 */
async function delegatedFrom(issueId: string) {
  const result = await linear.control<{ entity: { id: string } }>(
    "/__test/agents/delegate",
    { issueId, appUserId },
  );
  await recordedEvent(
    (e) =>
      e.action === "created" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        result.entity.id,
  );
  await settle();
  const session = await sessionRow(result.entity.id);
  if (!session) throw new Error("no mirror row");
  return { session };
}
