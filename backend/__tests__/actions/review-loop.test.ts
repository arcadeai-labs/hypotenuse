import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { reviewingThought } from "../../ops/DispatchOps";
import type { WorkItemReviewPayload } from "../../schema/work_items";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { activityRows, settle } from "../linear/sessions";
import {
  itemRow,
  itemsOf,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  callTool,
  type Held,
  heldSession,
  reviewsOf,
  sessionsOnIssue,
  subIssue,
} from "./dispatch-helpers";

/**
 * The review loop: a dispatched worker's finished turn comes back to its
 * manager as a `review` turn carrying the result — queued behind whatever
 * the manager is doing, offered one at a time, dropped when the child has
 * been sent back since — and the accountability rule on issue states.
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
let mario: ScriptedDaemon;

beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  mario = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "review-mario",
    { limits: { maxParallelJobs: 30 } },
  );
  await mario.heartbeat();
}, HOOK_TIMEOUT);

/**
 * A new manager session Mario's runner holds.
 * @param title - Its issue's title.
 * @returns The session.
 */
function managerSession(title: string): Promise<Held> {
  return heldSession(linear, appUserId, mario, title, "manager");
}

/**
 * Dispatch a new sub-issue of the manager's and claim the worker's turn.
 * @param manager - The manager session.
 * @param title - The sub-issue's title.
 * @returns The child session's id, issue, and claimed item.
 */
async function dispatchAndClaim(
  manager: Held,
  title: string,
): Promise<{ childId: number; issue: string; itemId: number }> {
  const issue = await subIssue(universe.url, mario, manager, title);
  const answer = await callTool(
    universe.url,
    mario,
    "hypotenuse_dispatch",
    manager.sessionId,
    { issue },
  );
  if (answer.status !== 200) throw new Error(JSON.stringify(answer.body));
  await linear.drain();
  await settle();
  const [child] = await sessionsOnIssue(issue);
  const [turn] = await itemsOf(child.id);
  const assignment = await mario.claim([turn.id]);
  if (!assignment) throw new Error("could not claim the worker's turn");
  return { childId: child.id, issue, itemId: turn.id };
}

/**
 * Finish a worker's turn with a response.
 * @param itemId - The turn.
 * @param body - Its answer.
 */
async function finishWorker(itemId: number, body: string): Promise<void> {
  await mario.events(itemId, [{ type: "response", body }]);
  const done = await mario.complete(itemId, "completed");
  if (done.status !== 200) throw new Error(JSON.stringify(done.body));
}

/**
 * The bodies of a session's outbound thoughts.
 * @param agentSessionId - The session.
 * @returns The bodies, in order.
 */
async function thoughts(agentSessionId: number): Promise<string[]> {
  return (await activityRows(agentSessionId))
    .filter((r) => r.direction === "outbound" && r.contentType === "thought")
    .map((r) => (r.content as { body: string }).body);
}

/**
 * A review item's payload.
 * @param item - The item.
 * @param item.payload - Its payload.
 * @returns The review.
 */
function review(item: { payload: unknown }): WorkItemReviewPayload {
  return (item.payload as { review: WorkItemReviewPayload }).review;
}

describe("a finished worker", () => {
  test("queues one review on its manager, sticky, carrying its result — offered only once the manager's turn ends", async () => {
    const manager = await managerSession("Plan the importer");
    const child = await dispatchAndClaim(manager, "Parse the CSV");
    await mario.events(child.itemId, [
      {
        type: "plan",
        entries: [
          { content: "Write the parser", status: "completed" },
          { content: "Test it", status: "completed" },
        ],
      },
      {
        type: "external_url",
        label: "Pull Request",
        url: "https://github.com/acme/web/pull/7",
      },
    ]);
    await finishWorker(child.itemId, "Parser done; see the pull request.");

    const [queued] = await reviewsOf(manager.sessionId);
    expect(queued).toMatchObject({
      status: "queued",
      role: "manager",
      stickyRunnerId: mario.id,
    });
    expect(review(queued)).toEqual({
      childSessionId: child.childId,
      childIssueIdentifier: child.issue,
      childIssueUrl: expect.any(String),
      reviewRound: 0,
      outcome: "completed",
      finalResponse: "Parser done; see the pull request.",
      plan: [
        { content: "Write the parser", status: "completed" },
        { content: "Test it", status: "completed" },
      ],
      pullRequests: [
        { label: "Pull Request", url: "https://github.com/acme/web/pull/7" },
      ],
    });

    // The manager is mid-turn: the review waits, and says nothing yet.
    await settle();
    expect((await itemRow(queued.id)).status).toBe("queued");
    const reviewing = reviewingThought(review(queued));
    expect(await thoughts(manager.sessionId)).not.toContain(reviewing);

    await mario.events(manager.workItemId, [
      { type: "response", body: "Dispatched the parser." },
    ]);
    await mario.complete(manager.workItemId, "completed");
    await settle();
    expect((await itemRow(queued.id)).status).toBe("offered");
    expect(await thoughts(manager.sessionId)).toContain(reviewing);
    expect(reviewing).toBe(`Reviewing ${child.issue} (round 1)…`);

    const assignment = await mario.claim([queued.id]);
    expect(assignment?.kind).toBe("review");
    expect(assignment?.role).toBe("manager");
    expect(assignment?.review).toMatchObject({
      childAgentSessionId: child.childId,
      childIssueIdentifier: child.issue,
      reviewRound: 0,
      outcome: "completed",
      finalResponse: "Parser done; see the pull request.",
      pullRequests: [
        { label: "Pull Request", url: "https://github.com/acme/web/pull/7" },
      ],
    });
    await mario.events(queued.id, [{ type: "response", body: "Accepted." }]);
    await mario.complete(queued.id, "completed");
  });

  test("two children finishing back to back queue two reviews, offered one at a time", async () => {
    const manager = await managerSession("Plan the exporter");
    const a = await dispatchAndClaim(manager, "Export JSON");
    const b = await dispatchAndClaim(manager, "Export XML");
    await finishWorker(a.itemId, "JSON done.");
    await finishWorker(b.itemId, "XML done.");
    await mario.events(manager.workItemId, [
      { type: "response", body: "Dispatched both." },
    ]);
    await mario.complete(manager.workItemId, "completed");

    const reviews = await reviewsOf(manager.sessionId);
    expect(reviews.map((r) => review(r).childSessionId)).toEqual([
      a.childId,
      b.childId,
    ]);
    await settle();
    expect((await reviewsOf(manager.sessionId)).map((r) => r.status)).toEqual([
      "offered",
      "queued",
    ]);

    await mario.claim([reviews[0].id]);
    await mario.events(reviews[0].id, [{ type: "response", body: "OK." }]);
    await mario.complete(reviews[0].id, "completed");
    await settle();
    expect((await reviewsOf(manager.sessionId)).map((r) => r.status)).toEqual([
      "completed",
      "offered",
    ]);
    await mario.claim([reviews[1].id]);
    await mario.events(reviews[1].id, [{ type: "response", body: "OK." }]);
    await mario.complete(reviews[1].id, "completed");
  });

  test("a review of a child sent back since is cancelled as superseded, silently", async () => {
    const manager = await managerSession("Plan the cache");
    const child = await dispatchAndClaim(manager, "Cache headers");
    await finishWorker(child.itemId, "Headers set.");
    const [stale] = await reviewsOf(manager.sessionId);

    // Still in its turn, the manager sends the child back.
    const changes = await callTool(
      universe.url,
      mario,
      "hypotenuse_dispatch",
      manager.sessionId,
      { issue: child.issue, mode: "changes", instructions: "Add ETags." },
    );
    expect(changes.status).toBe(200);
    await mario.events(manager.workItemId, [
      { type: "response", body: "Asked for ETags." },
    ]);
    await mario.complete(manager.workItemId, "completed");
    await settle();

    expect(await itemRow(stale.id)).toMatchObject({
      status: "cancelled",
      cancelReason: "superseded",
    });
    expect(await thoughts(manager.sessionId)).not.toContain(
      reviewingThought(review(stale)),
    );
  });

  test("a worker that ends its turn on a question queues no review", async () => {
    const manager = await managerSession("Plan the search");
    const child = await dispatchAndClaim(manager, "Search box");
    await mario.events(child.itemId, [
      { type: "elicitation", body: "Which index should it use?" },
    ]);
    await mario.complete(child.itemId, "completed");
    expect(await reviewsOf(manager.sessionId)).toHaveLength(0);
  });
});

describe("issue states and accountability", () => {
  /**
   * `linear_set_issue_state` as Mario's runner.
   * @param session - The calling session.
   * @param issue - The target.
   * @param state - The state name or type.
   * @returns The answer.
   */
  function setState(session: Held, issue: string, state: string) {
    return callTool(
      universe.url,
      mario,
      "linear_set_issue_state",
      session.sessionId,
      { issue, state },
    );
  }

  /**
   * Change the project's manager settings as Peach.
   * @param manager - The section's changes.
   */
  async function managerSettings(manager: Record<string, unknown>) {
    const res = await fetch(`${universe.url}/api/project/settings`, {
      method: "POST",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, manager }),
    });
    expect(res.status).toBe(200);
  }

  test("a manager cannot complete an issue by default, may when the project allows it, and may always move one to started", async () => {
    const manager = await managerSession("Plan the states");
    const issue = await subIssue(universe.url, mario, manager, "Finish me");

    const started = await setState(manager, issue, "started");
    expect(started.status).toBe(200);

    const refused = await setState(manager, issue, "completed");
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain(
      "does not let a manager complete issues",
    );

    await managerSettings({ canCompleteIssues: true });
    const allowed = await setState(manager, issue, "completed");
    expect(allowed.status).toBe(200);
    await managerSettings({ canCompleteIssues: null });
  });

  test("a worker can never complete an issue, whatever the project allows", async () => {
    await managerSettings({ canCompleteIssues: true });
    const worker = await heldSession(
      linear,
      appUserId,
      mario,
      "Implement the states",
      "worker",
    );
    const refused = await setState(
      worker,
      worker.issue.identifier,
      "completed",
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain(
      "A worker cannot complete an issue",
    );
    await managerSettings({ canCompleteIssues: null });
  });
});

describe("agent-session:view", () => {
  test("draws the dispatch tree: a manager's children with rounds and pull requests, and a child's parent", async () => {
    const manager = await managerSession("Plan the tree");
    const child = await dispatchAndClaim(manager, "A leaf");
    await mario.events(child.itemId, [
      {
        type: "external_url",
        label: "Pull Request",
        url: "https://github.com/acme/web/pull/9",
      },
    ]);
    await finishWorker(child.itemId, "Leaf done.");
    await settle();

    /**
     * Read a session as Toad, a member.
     * @param id - The session.
     * @returns The body.
     */
    const view = async (id: number) => {
      const res = await fetch(
        `${universe.url}/api/agent-session/${id}?projectId=${universe.projectId}`,
        { headers: authHeaders(universe.toad.sessionId) },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        agentSession: { parentAgentSessionId: number | null };
        parent: { id: number; role: string } | null;
        children: Record<string, unknown>[];
      };
    };

    const top = await view(manager.sessionId);
    expect(top.parent).toBeNull();
    expect(top.children).toEqual([
      {
        id: child.childId,
        issueIdentifier: child.issue,
        issueUrl: expect.any(String),
        issueTitle: "A leaf",
        status: expect.any(String),
        role: "worker",
        dispatchMode: "new",
        reviewRound: 0,
        pullRequests: [
          { label: "Pull Request", url: "https://github.com/acme/web/pull/9" },
        ],
        workStatus: "completed",
      },
    ]);

    const leaf = await view(child.childId);
    expect(leaf.agentSession.parentAgentSessionId).toBe(manager.sessionId);
    expect(leaf.parent).toMatchObject({
      id: manager.sessionId,
      role: "manager",
    });
    expect(leaf.children).toEqual([]);
  });
});
