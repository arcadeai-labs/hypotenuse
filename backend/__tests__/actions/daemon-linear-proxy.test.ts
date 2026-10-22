import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HYPOTENUSE_TOOLS,
  type HypotenuseToolName,
} from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { NOT_PERMITTED_MESSAGE } from "../../middleware/daemonSessionScope";
import { DAEMON_ONLY_ACTION_NAMES } from "../../ops/DaemonPolicyOps";
import { ASKED_TEXT } from "../../ops/DaemonToolOps";
import { MANAGER_TOOLS, WORKER_TOOLS } from "../../ops/DaemonToolPolicyOps";
import { bucketKey } from "../../ops/LinearBucketOps";
import { catalogKey, loadCatalog } from "../../ops/LinearCatalogOps";
import { rateLimitKey } from "../../ops/LinearOps";
import { agentSessions } from "../../schema/agent_sessions";
import { workItems } from "../../schema/work_items";
import {
  FINEAR_FIXTURES,
  FINEAR_PRIMARY_KEY,
  useFinear,
} from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { activityRows, finearSession, settle } from "../linear/sessions";
import {
  delegatedSession,
  itemRow,
  itemsOf,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { daemonHeaders, TOOL_EXAMPLES } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";

/**
 * The agent tools' server half: the 18 `daemon:linear-*` and `daemon:dispatch`
 * actions behind `hypotenuse mcp`, driven by scripted daemons against finear.
 * Two runners (Mario's and Luigi's) hold three live sessions — a worker and a
 * manager on Mario's, a worker on Luigi's — and Mario's runner also has a
 * session whose turn is over. Every call is scoped on the server to a session
 * the calling runner holds now; what it may touch is checked against Linear.
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

// The bucket is the subject of one test; elsewhere it must not slow a file
// that makes a hundred Linear calls in a few seconds.
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
let luigi: ScriptedDaemon;

/** A live session and the turn its runner holds. */
interface Held {
  sessionId: number;
  externalSessionId: string;
  issue: { id: string; identifier: string };
  workItemId: number;
}
let worker: Held;
let manager: Held;
let luigis: Held;
let finished: Held;

/**
 * Start a session and have a daemon claim its first turn.
 * @param daemon - Who claims it.
 * @param title - The issue's title.
 * @param role - The role the session is given before the claim.
 * @returns The held session.
 */
async function held(
  daemon: ScriptedDaemon,
  title: string,
  role: "worker" | "manager" = "worker",
): Promise<Held> {
  const { issue, externalSessionId, session } = await delegatedSession(
    linear,
    appUserId,
    title,
  );
  const [first] = await itemsOf(session.id);
  if (role === "manager") {
    await api.db.db
      .update(agentSessions)
      .set({ role })
      .where(eq(agentSessions.id, session.id));
    await api.db.db
      .update(workItems)
      .set({ role })
      .where(eq(workItems.id, first.id));
  }
  const assignment = await daemon.claim([first.id]);
  if (!assignment) throw new Error(`${daemon.runner.name} could not claim`);
  return {
    sessionId: session.id,
    externalSessionId,
    issue,
    workItemId: assignment.workItemId,
  };
}

/** A tool call's raw answer. */
interface Called {
  status: number;
  text: string;
  body: {
    result?: { text: string; data: Record<string, unknown> };
    error?: { message: string };
  };
}

/**
 * Call one tool's action as a runner.
 * @param daemon - The calling runner.
 * @param tool - The MCP tool name.
 * @param agentSessionId - The session the call names.
 * @param input - The tool input.
 * @returns The status, raw body text, and parsed body.
 */
async function call(
  daemon: ScriptedDaemon,
  tool: HypotenuseToolName,
  agentSessionId: number,
  input: Record<string, unknown> = {},
): Promise<Called> {
  const def = HYPOTENUSE_TOOLS.find((t) => t.name === tool)!;
  const res = await fetch(`${universe.url}/api${def.route}`, {
    method: "POST",
    headers: daemonHeaders(daemon.runner.token),
    body: JSON.stringify({ ...input, agentSessionId }),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

/**
 * Create an issue in finear as Human 1.
 * @param teamId - The team.
 * @param title - The title.
 * @returns Its id and identifier.
 */
async function humanIssue(
  teamId: string,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const reply = await linear.graphql<{
    issueCreate: { issue: { id: string; identifier: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
    { input: { teamId, title } },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.issueCreate.issue;
}

beforeAll(async () => {
  // Human 1 joins the private team, so the install grants the app both teams.
  linear.joinTeam(FINEAR_FIXTURES.primary.privateTeam);
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  mario = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "proxy-mario",
    { limits: { maxParallelJobs: 5 } },
  );
  await mario.heartbeat();
  worker = await held(mario, "Fix the flaky retry test");
  manager = await held(mario, "Plan the webhook launch", "manager");
  finished = await held(mario, "An old session");
  await mario.events(finished.workItemId, [
    { type: "response", body: "Done." },
  ]);
  await mario.complete(finished.workItemId, "completed");
  // Mario's runner takes nothing more, so the next session goes to Luigi's.
  await mario.heartbeat({ draining: true });
  luigi = await ScriptedDaemon.register(
    universe.url,
    universe.luigi,
    universe.projectId,
    "proxy-luigi",
  );
  await luigi.heartbeat();
  luigis = await held(luigi, "Luigi's issue");
}, HOOK_TIMEOUT);

describe("the allowlist", () => {
  test("the tool actions are exactly the eighteen, all daemon-only and never MCP", () => {
    const registered = api.actions.actions
      .map((a) => a.name)
      .filter((name) => /^daemon:(linear-|dispatch$)/.test(name))
      .sort();
    expect(registered).toEqual(
      [
        "daemon:dispatch",
        "daemon:linear-ask-user",
        "daemon:linear-comment",
        "daemon:linear-create-document",
        "daemon:linear-create-issue",
        "daemon:linear-create-relation",
        "daemon:linear-create-sub-issue",
        "daemon:linear-get-issue",
        "daemon:linear-get-project",
        "daemon:linear-list-comments",
        "daemon:linear-list-labels",
        "daemon:linear-report-pr",
        "daemon:linear-search-issues",
        "daemon:linear-set-issue-state",
        "daemon:linear-set-plan",
        "daemon:linear-update-document",
        "daemon:linear-update-issue",
        "daemon:linear-update-project",
      ].sort(),
    );
    for (const name of registered) {
      expect(DAEMON_ONLY_ACTION_NAMES.has(name), name).toBe(true);
      const action = api.actions.actions.find((a) => a.name === name)!;
      expect(action.mcp?.tool, name).toBe(false);
    }
  });

  test("WORKER_TOOLS ⊂ MANAGER_TOOLS: eight of eighteen", () => {
    expect(WORKER_TOOLS.size).toBe(8);
    expect(MANAGER_TOOLS.size).toBe(18);
    for (const name of WORKER_TOOLS) expect(MANAGER_TOOLS.has(name)).toBe(true);
  });
});

describe("refusal is uniform", () => {
  test("another runner's session, a finished turn, no such session, and a worker calling a manager tool all answer the same bytes", async () => {
    const bodies = new Set<string>();
    for (const def of HYPOTENUSE_TOOLS) {
      const input = TOOL_EXAMPLES[def.action];
      const cases: [string, number][] = [
        ["another runner's session", luigis.sessionId],
        ["a finished turn", finished.sessionId],
        ["no such session", 999_999],
      ];
      if (!WORKER_TOOLS.has(def.action))
        cases.push(["a worker session", worker.sessionId]);
      for (const [why, sessionId] of cases) {
        const answer = await call(mario, def.name, sessionId, input);
        expect(answer.status, `${def.name}: ${why}`).toBe(403);
        bodies.add(answer.text);
      }
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: { message: NOT_PERMITTED_MESSAGE } }),
    ]);
  });

  test("a stopping turn is refused too", async () => {
    const stopping = await held(luigi, "About to stop");
    await api.db.db
      .update(workItems)
      .set({ cancelRequestedAt: new Date(), cancelReason: "stop" })
      .where(eq(workItems.id, stopping.workItemId));
    const answer = await call(luigi, "linear_get_issue", stopping.sessionId);
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: { message: NOT_PERMITTED_MESSAGE } });
  });
});

describe("a worker's tools", () => {
  test("linear_get_issue reads its own issue by default", async () => {
    const answer = await call(mario, "linear_get_issue", worker.sessionId);
    expect(answer.status).toBe(200);
    expect(answer.body.result!.text).toContain(
      `# ${worker.issue.identifier}: Fix the flaky retry test`,
    );
    expect(answer.body.result!.text).toContain("Steps to reproduce");
    expect(
      (answer.body.result!.data.issue as { identifier: string }).identifier,
    ).toBe(worker.issue.identifier);
  });

  test("LC-ACT-13 linear_comment posts as the app on its own issue, and is recorded", async () => {
    const answer = await call(mario, "linear_comment", worker.sessionId, {
      body: "A question for the reviewer is answered in the PR.\0",
    });
    expect(answer.status).toBe(200);
    const reply = await linear.graphql<{
      issue: {
        comments: { nodes: { body: string; user: { id: string } }[] };
      };
    }>(
      `Bearer ${await appToken(universe.projectId)}`,
      `query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body user { id } } } } }`,
      { id: worker.issue.id },
    );
    const posted = reply.data!.issue.comments.nodes.find((c) =>
      c.body.startsWith("A question for the reviewer"),
    );
    expect(posted?.user.id).toBe(appUserId);
    expect(posted?.body).not.toContain("\0");
    const item = await itemRow(worker.workItemId);
    expect(item.linearWrites).toEqual([
      expect.objectContaining({
        tool: "linear_comment",
        target: worker.issue.identifier,
      }),
    ]);

    const listed = await call(mario, "linear_list_comments", worker.sessionId);
    expect(listed.body.result!.text).toContain("A question for the reviewer");
  });

  test("linear_comment on another issue is refused", async () => {
    const answer = await call(mario, "linear_comment", worker.sessionId, {
      body: "Hello",
      issue: manager.issue.identifier,
    });
    expect(answer.status).toBe(403);
    expect(answer.body.error!.message).toContain(
      `${manager.issue.identifier} is not the issue you are working on`,
    );
  });

  test("a body over 64 KB is refused with its size", async () => {
    const answer = await call(mario, "linear_comment", worker.sessionId, {
      body: "x".repeat(70_000),
    });
    expect(answer.status).toBe(406);
    expect(answer.body.error!.message).toContain("70000 bytes");
  });

  test("linear_set_issue_state moves its issue, but never to a canceled state", async () => {
    const moved = await call(
      mario,
      "linear_set_issue_state",
      worker.sessionId,
      {
        state: "started",
      },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.result!.text).toContain(
      `Moved ${worker.issue.identifier}`,
    );

    // finear has no canceled state (a gap); the catalog the tool reads gets one.
    const integration = await integrationRow(universe.projectId);
    const catalog = await loadCatalog(integration);
    const team = catalog.teams.find(
      (t) => t.id === FINEAR_FIXTURES.primary.team,
    )!;
    team.states.push({
      id: "canceled-state",
      name: "Canceled",
      type: "canceled",
      position: 99,
    });
    await api.redis.redis.set(
      catalogKey(integration.id),
      JSON.stringify(catalog),
    );
    const refused = await call(
      mario,
      "linear_set_issue_state",
      worker.sessionId,
      { state: "canceled" },
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error!.message).toContain(
      "A worker cannot cancel an issue",
    );
    await api.redis.redis.del(catalogKey(integration.id));
  });

  test("linear_search_issues finds issues by text", async () => {
    const answer = await call(mario, "linear_search_issues", worker.sessionId, {
      query: "webhook launch",
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result!.text).toContain(manager.issue.identifier);
    const empty = await call(
      mario,
      "linear_search_issues",
      worker.sessionId,
      {},
    );
    expect(empty.status).toBe(406);
  });

  test("linear_set_plan replaces the whole plan through the outbox", async () => {
    for (const steps of [
      [
        { content: "Reproduce", status: "completed" },
        { content: "Fix", status: "inProgress" },
      ],
      [{ content: "Ship", status: "pending" }],
    ]) {
      const answer = await call(mario, "linear_set_plan", worker.sessionId, {
        steps,
      });
      expect(answer.status).toBe(200);
    }
    await settle();
    const updates = (await activityRows(worker.sessionId)).filter(
      (r) => r.kind === "session_update" && "plan" in r.content,
    );
    expect(updates.at(-1)?.content.plan).toEqual([
      { content: "Ship", status: "pending" },
    ]);
    expect(updates.at(-1)?.deliveryStatus).toBe("sent");
  });

  test("linear_report_pr links a pull request on its repository only", async () => {
    const elsewhere = await call(mario, "linear_report_pr", worker.sessionId, {
      url: "https://github.com/other/lib/pull/1",
    });
    expect(elsewhere.status).toBe(406);
    expect(elsewhere.body.error!.message).toContain("github.com/acme/web");

    const answer = await call(mario, "linear_report_pr", worker.sessionId, {
      url: "https://github.com/acme/web/pull/42",
    });
    expect(answer.status).toBe(200);
    await settle();
    const link = (await activityRows(worker.sessionId)).find(
      (r) =>
        r.kind === "session_update" &&
        JSON.stringify(r.content.addedExternalUrls ?? []).includes("pull/42"),
    );
    expect(link?.content.addedExternalUrls).toEqual([
      { label: "Pull Request", url: "https://github.com/acme/web/pull/42" },
    ]);
    expect(link?.deliveryStatus).toBe("sent");
  });

  test("LC-SIG-02 linear_ask_user with options posts a select, and the session waits", async () => {
    const answer = await call(mario, "linear_ask_user", worker.sessionId, {
      question: "Keep the old retry header?",
      options: [{ label: "Keep it" }, { label: "Drop it", value: "drop" }],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result!.text).toBe(ASKED_TEXT);
    const item = await itemRow(worker.workItemId);
    expect(item.answeredAt).not.toBeNull();
    expect(item.awaitingAnswerSince).not.toBeNull();

    await settle();
    const asked = (await activityRows(worker.sessionId)).find(
      (r) => r.contentType === "elicitation",
    );
    expect(asked?.signal).toBe("select");
    expect(asked?.signalMetadata).toEqual({
      options: [
        { label: "Keep it", value: "Keep it" },
        { label: "Drop it", value: "drop" },
      ],
    });
    const seen = await finearSession(
      linear,
      await appToken(universe.projectId),
      worker.externalSessionId,
    );
    expect(seen.status).toBe("awaitingInput");
    expect(seen.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityElicitationContent",
    );

    // The turn ends without a response, and no fallback answer is posted.
    await mario.complete(worker.workItemId, "completed");
    await settle();
    const after = await finearSession(
      linear,
      await appToken(universe.projectId),
      worker.externalSessionId,
    );
    expect(after.status).toBe("awaitingInput");
  });
});

describe("a manager's tools", () => {
  test("LC-OAUTH-07 linear_create_issue creates as the app, attributed to the person", async () => {
    linear.clearRequests();
    const answer = await call(mario, "linear_create_issue", manager.sessionId, {
      title: "Write the launch checklist",
      description: "From the plan.",
      priority: 2,
    });
    expect(answer.status).toBe(200);
    const sent = linear
      .requests()
      .find((r) => r.operationName === "CreateIssue");
    const input = sent?.variables?.input as Record<string, unknown>;
    expect(input.createAsUser).toBe("Human 1 via Hypotenuse");
    expect(input.displayIconUrl).toEndWith("/favicon.svg");
    expect(input).not.toHaveProperty("assigneeId");
    const created = answer.body.result!.data.issue as { identifier: string };
    expect(created.identifier).toStartWith("ENG-");
  });

  test("linear_update_issue on an unrelated team's issue is refused", async () => {
    const theirs = await humanIssue(
      FINEAR_FIXTURES.primary.privateTeam,
      "Someone else's work",
    );
    const answer = await call(mario, "linear_update_issue", manager.sessionId, {
      issue: theirs.identifier,
      title: "Taken over",
    });
    expect(answer.status).toBe(403);
    expect(answer.body.error!.message).toContain("is not one you manage");
  });

  test("an issue the session created in another team can be updated", async () => {
    const created = await call(
      mario,
      "linear_create_issue",
      manager.sessionId,
      {
        title: "A private follow-up",
        team: "ENGP",
      },
    );
    expect(created.status).toBe(200);
    const issue = created.body.result!.data.issue as { identifier: string };
    expect(issue.identifier).toStartWith("ENGP-");
    const updated = await call(
      mario,
      "linear_update_issue",
      manager.sessionId,
      {
        issue: issue.identifier,
        priority: 1,
        estimate: 3,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.result!.text).toContain("priority, estimate");
  });

  test("sub-issues, relations, labels, and dispatch", async () => {
    const sub = await call(
      mario,
      "linear_create_sub_issue",
      manager.sessionId,
      {
        parent: manager.issue.identifier,
        title: "Draft the announcement",
      },
    );
    expect(sub.status).toBe(200);
    const child = sub.body.result!.data.issue as { identifier: string };

    const related = await call(
      mario,
      "linear_create_relation",
      manager.sessionId,
      {
        issue: child.identifier,
        relatedIssue: worker.issue.identifier,
        type: "blocks",
      },
    );
    expect(related.status).toBe(200);

    const labels = await call(mario, "linear_list_labels", manager.sessionId);
    expect(labels.status).toBe(200);

    const dispatched = await call(
      mario,
      "hypotenuse_dispatch",
      manager.sessionId,
      {
        issue: child.identifier,
        instruction: "Keep it short.",
      },
    );
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.result!.data.dispatched).toBe(false);
    const writes = (await itemRow(manager.workItemId)).linearWrites.map(
      (w) => w.tool,
    );
    expect(writes).toContain("hypotenuse_dispatch");
    expect(writes).toContain("linear_create_relation");
  });

  test("the project's PRD, status, and documents", async () => {
    const statuses = await linear.graphql<{
      organization: { projectStatuses: { id: string; type: string }[] };
    }>(FINEAR_PRIMARY_KEY, `{ organization { projectStatuses { id type } } }`);
    const made = await linear.graphql<{
      projectCreate: { project: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
      {
        input: {
          name: "Webhook launch",
          teamIds: [FINEAR_FIXTURES.primary.team],
          statusId: statuses.data!.organization.projectStatuses[0]!.id,
        },
      },
    );
    const projectId = made.data!.projectCreate.project.id;
    await linear.graphql(
      FINEAR_PRIMARY_KEY,
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: manager.issue.id, input: { projectId } },
    );
    await api.redis.redis.del(
      catalogKey((await integrationRow(universe.projectId)).id),
    );

    const prd = await call(mario, "linear_update_project", manager.sessionId, {
      content: "# The launch\n\nShip it.",
      summary: "Launch the hardened webhooks.",
      status: "started",
    });
    expect(prd.status).toBe(200);
    const doc = await call(mario, "linear_create_document", manager.sessionId, {
      title: "Rollout",
      content: "# Rollout",
    });
    expect(doc.status).toBe(200);
    const id = (doc.body.result!.data.document as { id: string }).id;
    expect(linear.documents.get(id)?.projectId).toBe(projectId);
    const edited = await call(
      mario,
      "linear_update_document",
      manager.sessionId,
      { document: id, content: "# Rollout, v2" },
    );
    expect(edited.status).toBe(200);
    expect(linear.documents.get(id)?.content).toBe("# Rollout, v2");

    const read = await call(mario, "linear_get_project", manager.sessionId);
    expect(read.status).toBe(200);
    expect(read.body.result!.text).toContain("Ship it.");
    expect(read.body.result!.text).toContain("Rollout");
  });
});

describe("the token bucket", () => {
  test("a read gives up after its wait; a write waits for a token", async () => {
    const integration = await integrationRow(universe.projectId);
    const saved = {
      rate: config.linear.requestsPerHour,
      read: config.linear.toolReadWaitMs,
    };
    config.linear.requestsPerHour = 5000;
    config.linear.toolReadWaitMs = 200;
    try {
      await api.redis.redis.del(rateLimitKey(integration.id));
      await api.redis.redis.hset(bucketKey(integration.id), {
        tokens: 0,
        ts: Date.now(),
      });
      const read = await call(mario, "linear_get_issue", manager.sessionId);
      expect(read.status).toBe(429);
      expect(read.body.error!.message).toBe(
        "Linear rate limit reached; try again shortly",
      );

      // Half a token short of what a normal-priority take needs: the write
      // (and the read its scope check makes first) waits the few hundred ms
      // it takes to refill, then goes.
      config.linear.toolReadWaitMs = saved.read;
      await api.redis.redis.hset(bucketKey(integration.id), {
        tokens: config.linear.bucketReserve + 0.5,
        ts: Date.now(),
      });
      const started = Date.now();
      const write = await call(mario, "linear_comment", manager.sessionId, {
        body: "Written once a token was free.",
      });
      expect(write.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThan(100);
    } finally {
      config.linear.requestsPerHour = saved.rate;
      config.linear.toolReadWaitMs = saved.read;
      await api.redis.redis.del(bucketKey(integration.id));
    }
  });
});
