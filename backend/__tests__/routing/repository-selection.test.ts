import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { parseRepositoryAnswer, repositoryOption } from "../../ops/RoutingOps";
import {
  REPOSITORY_RETRY_BODY,
  repositoryQuestion,
} from "../../ops/WorkRouteOps";
import type { AgentActivity } from "../../schema/agent_activities";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  activityRows,
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  delegatedSession,
  itemsOf,
  personSays,
  ScriptedDaemon,
  sessionById,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Choosing the repository: a rule's pin, then the only candidate, then
 * Linear's suggestion above the project's confidence, then a `select` a
 * person answers in an ordinary prompt.
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

const WEB = { name: "web", remote: "github.com/acme/web", baseBranch: "main" };
const API = { name: "api", remote: "github.com/acme/api", baseBranch: "main" };

let appUserId: string;
let daemon: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  daemon = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "repos",
    { limits: { maxParallelJobs: 50 } },
  );
  await daemon.heartbeat();
}, HOOK_TIMEOUT);

/**
 * Whether finear has been asked for repository suggestions since the log was
 * cleared.
 * @returns True when it has.
 */
function askedLinear(): boolean {
  return linear
    .requests()
    .some((r) => r.operationName === "IssueRepositorySuggestions");
}

/**
 * Report both repositories from now on.
 */
async function bothRepositories(): Promise<void> {
  await daemon.heartbeat({
    capabilities: { ...daemon.shape.capabilities, repositories: [WEB, API] },
  });
}

/**
 * Delegate a new issue after telling finear what Linear would suggest for it.
 * @param title - The issue's title.
 * @param suggestions - `[repositoryFullName, confidence]` pairs on github.com.
 * @returns The mirror row.
 */
async function suggested(title: string, suggestions: [string, number][]) {
  const issue = await createIssue(linear, title);
  await linear.control("/__test/repository-suggestions", {
    issueId: issue.id,
    suggestions: suggestions.map(([repositoryFullName, confidence]) => ({
      hostname: "github.com",
      repositoryFullName,
      confidence,
    })),
  });
  const externalSessionId = await delegate(linear, issue.id, appUserId);
  await recordedEvent(
    (e) =>
      e.action === "created" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
  );
  await settle();
  return (await sessionRow(externalSessionId))!;
}

/**
 * A session's elicitations, oldest first.
 * @param agentSessionId - The session.
 * @returns The rows.
 */
async function elicitations(agentSessionId: number): Promise<AgentActivity[]> {
  return (await activityRows(agentSessionId)).filter(
    (r) => r.contentType === "elicitation",
  );
}

/**
 * Change the project's routing settings as Peach.
 * @param routing - The keys to set.
 */
async function setRouting(routing: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${universe.url}/api/project/settings`, {
    method: "POST",
    headers: authHeaders(universe.peach.sessionId),
    body: JSON.stringify({ projectId: universe.projectId, routing }),
  });
  expect(res.status).toBe(200);
}

describe("parseRepositoryAnswer", () => {
  const options = [
    repositoryOption("github.com/acme/web"),
    repositoryOption("github.com/acme/api"),
  ];
  const pick = (body: string) => parseRepositoryAnswer(body, options)?.label;

  test("LC-SIG-03 an exact value, label, remote, or owner/name, forgivingly", () => {
    expect(pick("https://github.com/acme/web")).toBe("acme/web");
    expect(pick("acme/api")).toBe("acme/api");
    expect(pick("github.com/acme/api")).toBe("acme/api");
    expect(pick("ACME/Web")).toBe("acme/web");
    expect(pick("git@github.com:acme/api.git")).toBe("acme/api");
    expect(pick("https://github.com/acme/api.git/")).toBe("acme/api");
    expect(pick("  /acme/web/ ")).toBe("acme/web");
  });

  test("LC-SIG-03 free text naming exactly one repository", () => {
    expect(pick("please use acme/api for this")).toBe("acme/api");
    expect(pick("the web one")).toBe("acme/web");
    expect(pick("web, I think")).toBe("acme/web");
  });

  test("LC-SIG-03 free text naming two, or none, is no answer", () => {
    expect(pick("web or api, whichever")).toBeUndefined();
    expect(pick("the website")).toBeUndefined();
    expect(pick("no idea")).toBeUndefined();
    expect(pick("")).toBeUndefined();
  });
});

describe("selecting the repository", () => {
  test("LC-CTX-04 the only candidate is chosen without asking Linear", async () => {
    linear.clearRequests();
    const { session } = await delegatedSession(linear, appUserId, "One repo");
    expect(session.repository).toBe("github.com/acme/web");
    expect(askedLinear()).toBe(false);
    const bodies = (await activityRows(session.id)).map(
      (r) => (r.content as { body?: string }).body,
    );
    expect(bodies).toContain("Working in **acme/web**.");
    expect((await itemsOf(session.id))[0]).toMatchObject({
      repository: "github.com/acme/web",
      repositoryResolved: true,
      status: "offered",
    });
  });

  test("LC-CTX-04 a rule's pin wins without asking Linear", async () => {
    await bothRepositories();
    const res = await fetch(`${universe.url}/api/routing-rule`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        name: "Everything in api",
        role: "worker",
        repository: "git@github.com:acme/api.git",
      }),
    });
    expect(res.status).toBe(200);
    const { routingRule } = (await res.json()) as {
      routingRule: { id: number; repository: string };
    };
    expect(routingRule.repository).toBe("github.com/acme/api");

    linear.clearRequests();
    const { session } = await delegatedSession(linear, appUserId, "Pinned");
    expect(session.repository).toBe("github.com/acme/api");
    expect(askedLinear()).toBe(false);

    const removed = await fetch(
      `${universe.url}/api/routing-rule/${routingRule.id}`,
      {
        method: "DELETE",
        headers: authHeaders(universe.peach.sessionId),
        body: JSON.stringify({ projectId: universe.projectId }),
      },
    );
    expect(removed.status).toBe(200);
  });

  test("LC-CTX-04 Linear's top suggestion at or above the confidence is chosen", async () => {
    await bothRepositories();
    linear.clearRequests();
    const session = await suggested("Suggested", [
      ["acme/api", 0.9],
      ["acme/web", 0.1],
    ]);
    expect(askedLinear()).toBe(true);
    expect(session.repository).toBe("github.com/acme/api");
    expect(session.pendingRepositoryChoice).toBeNull();
    expect((await itemsOf(session.id))[0].status).toBe("offered");
  });

  test("LC-CTX-04 the project's confidence threshold is its own", async () => {
    await setRouting({ repositoryConfidence: 0.4 });
    try {
      const session = await suggested("Lower bar", [["acme/web", 0.5]]);
      expect(session.repository).toBe("github.com/acme/web");
    } finally {
      await setRouting({ repositoryConfidence: null });
    }
  });

  test("LC-SIG-03 LC-CTX-04 below the confidence a person is asked with a select, and their answer settles it", async () => {
    const session = await suggested("Unsure", [["acme/api", 0.5]]);
    expect(session.repository).toBeNull();
    expect(session.pendingRepositoryChoice).toMatchObject({
      misses: 0,
      options: [
        { label: "acme/api", value: "https://github.com/acme/api" },
        { label: "acme/web", value: "https://github.com/acme/web" },
      ],
    });
    const [asked] = await elicitations(session.id);
    expect(asked).toMatchObject({
      signal: "select",
      deliveryStatus: "sent",
      content: {
        type: "elicitation",
        body: repositoryQuestion(session.issueIdentifier),
      },
      signalMetadata: {
        options: [
          { label: "acme/api", value: "https://github.com/acme/api" },
          { label: "acme/web", value: "https://github.com/acme/web" },
        ],
      },
    });
    expect((await itemsOf(session.id))[0]).toMatchObject({
      status: "queued",
      repositoryResolved: false,
    });

    await personSays(
      linear,
      session.externalSessionId,
      "https://github.com/acme/web",
    );
    const after = await sessionById(session.id);
    expect(after.repository).toBe("github.com/acme/web");
    expect(after.pendingRepositoryChoice).toBeNull();
    const items = await itemsOf(session.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repository: "github.com/acme/web",
      repositoryResolved: true,
      status: "offered",
    });
  });

  test("LC-SIG-03 a miss asks once more; a second ends the turn naming the candidates", async () => {
    const session = await suggested("Confusing", [["acme/api", 0.3]]);
    await personSays(linear, session.externalSessionId, "no idea, you pick");
    const asked = await elicitations(session.id);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({
      signal: "select",
      content: { body: REPOSITORY_RETRY_BODY },
    });
    expect(
      (await sessionById(session.id)).pendingRepositoryChoice,
    ).toMatchObject({ misses: 1 });

    await personSays(linear, session.externalSessionId, "still no idea");
    const last = (await activityRows(session.id)).at(-1)!;
    expect(last.contentType).toBe("error");
    expect((last.content as { body: string }).body).toContain(
      "acme/api, acme/web",
    );
    expect((await sessionById(session.id)).pendingRepositoryChoice).toBeNull();
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "failed",
    ]);
  });
});
