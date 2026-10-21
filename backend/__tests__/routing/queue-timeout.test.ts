import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { runners } from "../../schema/runners";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { activityRows, settle } from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  ago,
  delegatedSession,
  itemsOf,
  personSays,
  route,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * A turn no runner takes within the project's queue timeout expires with an
 * `error` naming the reason the data supports — never silently dropped.
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
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
}, HOOK_TIMEOUT);

const WEB = { name: "web", remote: "github.com/acme/web", baseBranch: "main" };
const API = { name: "api", remote: "github.com/acme/api", baseBranch: "main" };
const PREFIX = "No runner took this within 30 minutes.";

/**
 * Start a session, push its first turn past the queue timeout, route, and
 * read what happened.
 * @param title - The issue's title.
 * @returns The item's final status and the session's last error, if any.
 */
async function expired(title: string) {
  const { session } = await delegatedSession(linear, appUserId, title);
  const [item] = await itemsOf(session.id);
  await setItem(item.id, { queuedAt: ago(31 * 60_000) });
  await route();
  await settle();
  const [after] = await itemsOf(session.id);
  const error = (await activityRows(session.id))
    .filter((r) => r.contentType === "error")
    .at(-1);
  return {
    status: after.status,
    error: (error?.content as { body?: string } | undefined)?.body,
  };
}

/**
 * Change a runner's row directly: presence and the pause switch.
 * @param id - The runner.
 * @param set - The columns.
 */
async function setRunner(
  id: number,
  set: Partial<typeof runners.$inferInsert>,
): Promise<void> {
  await api.db.db.update(runners).set(set).where(eq(runners.id, id));
}

describe("the queue timeout", () => {
  let daemon: ScriptedDaemon;

  test("no runner takes the work", async () => {
    const { status, error } = await expired("Nobody");
    expect(status).toBe("expired");
    expect(error).toBe(
      `${PREFIX} No runner in this project takes worker work to ENG.`,
    );
  });

  test("every runner that would is offline", async () => {
    daemon = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      "sleepy",
    );
    await daemon.heartbeat();
    await setRunner(daemon.id, { status: "offline" });
    const { status, error } = await expired("Offline");
    expect(status).toBe("expired");
    expect(error?.startsWith(PREFIX)).toBe(true);
    expect(error).toContain(
      "1 runner takes worker work to ENG; it is offline.",
    );
  });

  test("the online one is paused", async () => {
    await daemon.heartbeat();
    await setRunner(daemon.id, { enabled: false });
    const { status, error } = await expired("Paused");
    expect(status).toBe("expired");
    expect(error).toContain("the online one is paused.");
    await setRunner(daemon.id, { enabled: true });
  });

  test("none has an available agent for the role", async () => {
    await daemon.heartbeat({
      capabilities: {
        ...daemon.shape.capabilities,
        agents: [{ id: "claude", preset: "claude", available: false }],
      },
    });
    const { status, error } = await expired("No agent");
    expect(status).toBe("expired");
    expect(error).toContain(
      "none online has an available agent for the worker role.",
    );
  });

  test("none has a repository checked out", async () => {
    await daemon.heartbeat({
      capabilities: {
        ...daemon.shape.capabilities,
        agents: [{ id: "claude", preset: "claude", available: true }],
        repositories: [],
      },
    });
    const { status, error } = await expired("No repository");
    expect(status).toBe("expired");
    expect(error).toContain("none online has a repository checked out.");
  });

  test("every runner that could is busy", async () => {
    await daemon.heartbeat({
      limits: { maxParallelJobs: 1 },
      capabilities: { ...daemon.shape.capabilities, repositories: [WEB] },
    });
    const { session: busy } = await delegatedSession(
      linear,
      appUserId,
      "Keeps it busy",
    );
    const held = await daemon.claim();
    expect(held?.agentSessionId).toBe(busy.id);

    const { status, error } = await expired("Too busy");
    expect(status).toBe("expired");
    expect(error?.startsWith(PREFIX)).toBe(true);
    expect(error).toContain("the one that could is busy.");
  });

  test("a turn waiting on a person's repository answer never expires", async () => {
    await daemon.heartbeat({
      limits: { maxParallelJobs: 10 },
      capabilities: { ...daemon.shape.capabilities, repositories: [WEB, API] },
    });
    const { session } = await delegatedSession(linear, appUserId, "Which?");
    expect(session.pendingRepositoryChoice).not.toBeNull();
    const [item] = await itemsOf(session.id);
    await setItem(item.id, { queuedAt: ago(2 * 60 * 60_000) });
    await route();
    expect((await itemsOf(session.id))[0].status).toBe("queued");
  });

  test("a worker's follow-up after a turn that expired without a repository chooses one again", async () => {
    await daemon.heartbeat({
      capabilities: { ...daemon.shape.capabilities, repositories: [] },
    });
    const { externalSessionId, session, status } = await (async () => {
      const started = await delegatedSession(linear, appUserId, "Later");
      const [item] = await itemsOf(started.session.id);
      await setItem(item.id, { queuedAt: ago(31 * 60_000) });
      await route();
      await settle();
      return {
        ...started,
        status: (await itemsOf(started.session.id))[0].status,
      };
    })();
    expect(status).toBe("expired");

    // A checkout arrives; the person asks again.
    await daemon.heartbeat({
      capabilities: { ...daemon.shape.capabilities, repositories: [WEB] },
    });
    await personSays(linear, externalSessionId, "Try again now");
    const followUp = (await itemsOf(session.id)).at(-1)!;
    expect(followUp).toMatchObject({
      kind: "prompt",
      repositoryResolved: true,
      repository: "github.com/acme/web",
    });
  });
});
