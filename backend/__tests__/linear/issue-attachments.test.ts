import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { enqueueIssueAttachment } from "../../ops/ActivityOutboxOps";
import { reviewStateKey } from "../../ops/IssueAttachmentOps";
import { agentActivities } from "../../schema/agent_activities";
import { agentSessions } from "../../schema/agent_sessions";
import { callTool, type Held, heldSession } from "../actions/dispatch-helpers";
import { ScriptedDaemon, withoutRunnerRateLimits } from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { integrationRow } from "./helpers";
import { settle } from "./sessions";

/**
 * A pull request linked to a session is attached to the session's issue,
 * through the outbox: by `attachmentLinkGitHubPR` where the workspace's GitHub
 * integration reaches it, else `attachmentLinkURL`; once per URL per issue,
 * whichever path linked it and however often; and the issue's first pull
 * request moves it to the team's review state, when the team has one and the
 * issue is not finished.
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

let savedRate = 0;
beforeAll(() => {
  savedRate = config.linear.requestsPerHour;
  config.linear.requestsPerHour = 3_600_000;
});
afterAll(() => {
  config.linear.requestsPerHour = savedRate;
});

let appUserId: string;
let integrationId: number;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const integration = await integrationRow(universe.projectId);
  appUserId = integration.externalAppUserId;
  integrationId = integration.id;
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "attach-laptop",
    { limits: { maxParallelJobs: 20 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * A worker session the laptop holds, on a new issue in Backlog.
 * @param title - The issue's title.
 * @returns The held session.
 */
function worker(title: string): Promise<Held> {
  return heldSession(linear, appUserId, laptop, title, "worker");
}

/**
 * The daemon's own detection of a pull request in the turn.
 * @param held - The session.
 * @param url - The pull request.
 */
async function detect(held: Held, url: string): Promise<void> {
  const answer = await laptop.events(held.workItemId, [
    { type: "external_url", label: "Pull Request", url },
  ]);
  expect(answer.status).toBe(200);
  await settle();
}

/**
 * `linear_report_pr` from the coding agent.
 * @param held - The session.
 * @param url - The pull request.
 * @returns The tool's answer.
 */
async function reportPr(held: Held, url: string) {
  const answer = await callTool(
    universe.url,
    laptop,
    "linear_report_pr",
    held.sessionId,
    { url },
  );
  await settle();
  return answer;
}

/**
 * The session's attachment rows.
 * @param agentSessionId - The session.
 * @returns The rows, oldest first.
 */
async function attachmentRows(agentSessionId: number) {
  return api.db.db
    .select()
    .from(agentActivities)
    .where(
      and(
        eq(agentActivities.agentSessionId, agentSessionId),
        eq(agentActivities.kind, "issue_attachment"),
      ),
    )
    .orderBy(agentActivities.seq);
}

/**
 * The stand-in's attachments on an issue.
 * @param issueId - The issue's UUID.
 * @returns They.
 */
function attachedTo(issueId: string) {
  return [...linear.attachments.values()].filter((a) => a.issueId === issueId);
}

/**
 * An issue's state, as finear has it.
 * @param id - The issue.
 * @returns Its state.
 */
async function stateOf(id: string) {
  const reply = await linear.graphql<{
    issue: { state: { id: string; name: string; type: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    "query($id: String!) { issue(id: $id) { state { id name type } } }",
    { id },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.issue.state;
}

/**
 * Move an issue, as Human 1.
 * @param id - The issue.
 * @param stateId - The state.
 */
async function moveIssue(id: string, stateId: string): Promise<void> {
  const reply = await linear.graphql(
    FINEAR_PRIMARY_KEY,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id, input: { stateId } },
  );
  if (reply.errors) throw new Error(JSON.stringify(reply.errors));
}

/** Forget the cached review state, after a test changes the team's states. */
async function forgetReviewState(): Promise<void> {
  await api.redis.redis.del(
    reviewStateKey(integrationId, FINEAR_FIXTURES.primary.team),
  );
}

describe("the attachment", () => {
  test("LC-ATT-01 LC-ATT-02 a detected GitHub pull request is attached to the issue: the GitHub link refused without the integration, then a URL link", async () => {
    const held = await worker("Attach by URL");
    const url = "https://github.com/acme/web/pull/101";
    linear.clearRequests();
    await detect(held, url);

    const sent = linear
      .requests()
      .map((r) => r.operationName)
      .filter((n) => n?.startsWith("Attachment"));
    expect(sent).toEqual(["AttachmentLinkGitHubPR", "AttachmentLinkURL"]);
    const [row] = await attachmentRows(held.sessionId);
    expect(row.deliveryStatus).toBe("sent");
    expect(row.content).toMatchObject({
      url,
      title: "Pull request #101",
      linkedVia: "url",
      githubRefusal: expect.stringContaining("GitHub integration"),
    });
    expect(attachedTo(held.issue.id)).toEqual([
      {
        id: row.clientActivityId,
        issueId: held.issue.id,
        url,
        title: "Pull request #101",
        via: "url",
      },
    ]);
    // The session link is there too, as before.
    const linkRequests = linear
      .requests()
      .filter((r) => r.operationName === "UpdateAgentSession");
    expect(JSON.stringify(linkRequests.map((r) => r.variables))).toContain(
      "pull/101",
    );
    await laptop.complete(held.workItemId, "completed");
  });

  test("LC-ATT-01 where the workspace's GitHub integration reaches the repository, the GitHub link is all it takes", async () => {
    linear.githubIntegration(true);
    try {
      const held = await worker("Attach by GitHub");
      linear.clearRequests();
      await detect(held, "https://github.com/acme/web/pull/102");
      expect(
        linear
          .requests()
          .map((r) => r.operationName)
          .filter((n) => n?.startsWith("Attachment")),
      ).toEqual(["AttachmentLinkGitHubPR"]);
      expect(attachedTo(held.issue.id).map((a) => a.via)).toEqual(["github"]);
      expect((await attachmentRows(held.sessionId))[0].content.linkedVia).toBe(
        "github",
      );
      await laptop.complete(held.workItemId, "completed");
    } finally {
      linear.githubIntegration(false);
    }
  });

  test("LC-ATT-02 another forge's pull request goes straight to a URL link", async () => {
    const held = await worker("Attach a merge request");
    linear.clearRequests();
    await detect(held, "https://gitlab.com/acme/web/-/merge_requests/7");
    expect(
      linear
        .requests()
        .map((r) => r.operationName)
        .filter((n) => n?.startsWith("Attachment")),
    ).toEqual(["AttachmentLinkURL"]);
    expect(attachedTo(held.issue.id).map((a) => a.title)).toEqual([
      "Pull request #7",
    ]);
    await laptop.complete(held.workItemId, "completed");
  });
});

describe("idempotency", () => {
  test("LC-ATT-03 detection, then linear_report_pr, then a second session on the issue: one attachment", async () => {
    const held = await worker("Attach once");
    const url = "https://github.com/acme/web/pull/103";
    await detect(held, url);
    const answer = await reportPr(held, url);
    expect(answer.status).toBe(200);
    expect(answer.body.result!.data.linked).toBe(false);
    expect(await attachmentRows(held.sessionId)).toHaveLength(1);

    // linear_report_pr first, on a session the daemon had not detected it in.
    const other = await worker("Report first");
    const reported = "https://github.com/acme/web/pull/104";
    expect((await reportPr(other, reported)).body.result!.data.linked).toBe(
      true,
    );
    await detect(other, reported);
    expect(await attachmentRows(other.sessionId)).toHaveLength(1);
    expect(attachedTo(other.issue.id)).toHaveLength(1);

    // A second session on the first issue links the same pull request.
    const [first] = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, held.sessionId));
    const { id: _id, ...copy } = first;
    const [second] = await api.db.db
      .insert(agentSessions)
      .values({ ...copy, externalSessionId: crypto.randomUUID() })
      .returning();
    const queued = await api.db.db.transaction((tx) =>
      enqueueIssueAttachment(tx, second.id, { label: "Pull Request", url }),
    );
    expect(queued).toBe(false);
    expect(await attachmentRows(second.id)).toHaveLength(0);
    expect(attachedTo(held.issue.id)).toHaveLength(1);
    await laptop.complete(held.workItemId, "completed");
    await laptop.complete(other.workItemId, "completed");
  });

  test("LC-ATT-03 a lost answer is retried with the same id, and Linear keeps one attachment", async () => {
    const held = await worker("Lose the answer");
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "AttachmentLinkURL",
    });
    linear.clearRequests();
    await detect(held, "https://github.com/acme/web/pull/105");
    const [row] = await attachmentRows(held.sessionId);
    expect(row.deliveryStatus).toBe("sent");
    const sends = linear
      .requests()
      .filter((r) => r.operationName === "AttachmentLinkURL");
    expect(sends.map((r) => r.variables?.id)).toEqual([
      row.clientActivityId,
      row.clientActivityId,
    ]);
    expect(attachedTo(held.issue.id).map((a) => a.id)).toEqual([
      row.clientActivityId,
    ]);
    await laptop.complete(held.workItemId, "completed");
  });
});

describe("the review-state move", () => {
  test("LC-DEL-08 a team with no review state leaves the issue where it is", async () => {
    await forgetReviewState();
    const held = await worker("No review state");
    await detect(held, "https://github.com/acme/web/pull/201");
    const [row] = await attachmentRows(held.sessionId);
    expect(row.content.review).toEqual({
      outcome: "skipped",
      detail: "the team has no review state",
    });
    // Where the claim's hygiene put it, and no further.
    expect((await stateOf(held.issue.id)).id).toBe(
      FINEAR_FIXTURES.primary.started,
    );
    await laptop.complete(held.workItemId, "completed");
  });

  test("LC-DEL-08 the issue's first pull request moves it to the team's review state; a second does not move it back", async () => {
    const review = linear.addWorkflowState({
      name: "In Review",
      type: "started",
      position: 1.5,
    });
    await forgetReviewState();
    const held = await worker("Ready for review");
    await detect(held, "https://github.com/acme/web/pull/202");
    expect(await stateOf(held.issue.id)).toMatchObject({
      id: review,
      name: "In Review",
    });
    const [first] = await attachmentRows(held.sessionId);
    expect(first.content.review).toEqual({
      outcome: "moved",
      detail: "In Review",
    });

    // A person takes it back to In Progress; the next pull request leaves it.
    await moveIssue(held.issue.id, FINEAR_FIXTURES.primary.started);
    await detect(held, "https://github.com/acme/web/pull/203");
    const [, second] = await attachmentRows(held.sessionId);
    expect(second.content.review).toEqual({
      outcome: "skipped",
      detail: "not the first pull request",
    });
    expect((await stateOf(held.issue.id)).id).toBe(
      FINEAR_FIXTURES.primary.started,
    );
    await laptop.complete(held.workItemId, "completed");
  });

  test("LC-DEL-08 a completed issue stays completed", async () => {
    const held = await worker("Already done");
    await moveIssue(held.issue.id, FINEAR_FIXTURES.primary.completed);
    await detect(held, "https://github.com/acme/web/pull/204");
    const [row] = await attachmentRows(held.sessionId);
    expect(row.content.review).toMatchObject({ outcome: "unchanged" });
    expect((await stateOf(held.issue.id)).type).toBe("completed");
    expect(attachedTo(held.issue.id)).toHaveLength(1);
    await laptop.complete(held.workItemId, "completed");
  });

  test("a manager's pull request is attached, and moves nothing", async () => {
    const held = await heldSession(
      linear,
      appUserId,
      laptop,
      "Manager PR",
      "manager",
    );
    const before = await stateOf(held.issue.id);
    await detect(held, "https://github.com/acme/web/pull/205");
    const [row] = await attachmentRows(held.sessionId);
    expect(row.content.review).toEqual({
      outcome: "skipped",
      detail: "manager role",
    });
    expect(attachedTo(held.issue.id)).toHaveLength(1);
    expect((await stateOf(held.issue.id)).id).toBe(before.id);
    await laptop.complete(held.workItemId, "completed");
  });
});
