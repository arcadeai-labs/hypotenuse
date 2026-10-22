import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { finearSession, settle } from "../linear/sessions";
import {
  delegatedSession,
  itemsOf,
  personSays,
  route,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, outbound, until } from "./helpers";

/**
 * The agent host end to end: a real backend, finear, the real daemon, and the
 * scripted fake ACP agent. A delegation becomes the agent's thoughts, actions,
 * plan, and response in Linear; an `ask` policy's permission request waits on
 * a person in Linear and resumes on their answer; free text instead becomes
 * the next turn's request; a Stop ends a running agent within its grace; and
 * an agent that is not logged in says how to fix it and is reported
 * unavailable until a reload.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill();
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let appUserId: string;
let token: string;
let home: DaemonHome;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "acp-laptop",
    { worker: 'permission_policy = { default = "allow", execute = "ask" }' },
  );
}, HOOK_TIMEOUT);

/**
 * Restart the daemon with its agent playing another scenario.
 * @param scenario - The fake agent's scenario.
 * @param turnMs - How long a long turn runs.
 */
async function playing(scenario: string, turnMs = 0): Promise<void> {
  await home.kill();
  home = new DaemonHome(
    home.root,
    home.url,
    home.runner,
    home.machine,
    turnMs,
    scenario,
  );
  await home.startForeground();
  // A session delegated before the new daemon's first heartbeat would find
  // the runner offline, and no routing clock runs here to try again.
  await until(async () => {
    const row = await runnerRow(home.runner.id);
    return row.status === "online" ? row : null;
  });
}

/**
 * Wait for a session's first work item to reach a status.
 * @param agentSessionId - The session.
 * @param status - The status.
 * @param index - Which item.
 * @returns The item.
 */
async function itemReaches(agentSessionId: number, status: string, index = 0) {
  return until(async () => {
    const item = (await itemsOf(agentSessionId))[index];
    return item?.status === status ? item : null;
  }, 30_000);
}

/**
 * Whether a process is alive.
 * @param pid - The process.
 * @returns True while it runs.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("acp host end to end", () => {
  test("LC-BP-06 a delegation: thoughts, actions, a plan, a summary, and a response in Linear", async () => {
    await playing("happy");
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Fix checkout rounding",
    );
    await itemReaches(session.id, "completed");
    await settle();

    const rows = await outbound(session.id);
    const persisted = rows
      .filter((r) => !r.ephemeral && r.contentType)
      .map((r) => [r.contentType, r.content]);
    // The server's own thoughts (acknowledgement, routing) come first.
    expect(persisted.filter(([type]) => type !== "thought")).toEqual([
      [
        "action",
        {
          type: "action",
          action: "Edited",
          parameter: "src/a.ts",
          result:
            "+1 −1 in src/a.ts\n\n+++ Diff\n```diff\n-round(x)\n+roundHalfEven(x)\n```\n+++",
        },
      ],
      [
        "response",
        { type: "response", body: "Fixed the rounding in `src/a.ts`." },
      ],
    ]);
    expect(persisted[0]?.[0]).toBe("thought");
    const ephemeral = rows
      .filter((r) => r.ephemeral)
      .map(
        (r) =>
          (r.content as { body?: string; action?: string }).body ??
          (r.content as { action?: string }).action,
      );
    expect(ephemeral).toEqual([
      "Starting claude in `github.com/acme/web`…",
      "Reading the issue. The rounding happens in src/a.ts.",
      "Editing",
    ]);

    const [row] = await itemsOf(session.id);
    expect(row.outcome?.acpSessionId).toMatch(/^fake-session-/);
    const finear = await finearSession(linear, token, externalSessionId);
    expect(finear.status).toBe("complete");
    expect(finear.activities.at(-1)?.content.body).toBe(
      "Fixed the rounding in `src/a.ts`.",
    );
    const [mirrored] = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, session.id));
    expect(mirrored?.plan).toEqual([
      { content: "Find the rounding", status: "completed" },
      { content: "Fix it", status: "completed" },
      { content: "Run the tests", status: "completed" },
    ]);
    expect(mirrored?.summary).toBe("Fix checkout rounding");
  }, 60_000);

  test("LC-ACT-05 ask: a select elicitation, awaitingInput, and an answer resumes the turn", async () => {
    await playing("permission");
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Clean the build",
    );
    await until(async () => {
      await settle();
      const f = await finearSession(linear, token, externalSessionId);
      return f.status === "awaitingInput" ? f : null;
    }, 30_000);
    const asked = (await outbound(session.id)).find(
      (r) => r.contentType === "elicitation",
    );
    expect(asked?.content).toEqual({
      type: "elicitation",
      body: "The agent wants to run `rm -rf build/` in `github.com/acme/web`. Allow it?",
    });
    expect(asked?.signal).toBe("select");
    expect(asked?.signalMetadata).toEqual({
      options: [
        { label: "Allow", value: "yes" },
        { label: "Always allow", value: "always" },
        { label: "Reject", value: "no" },
      ],
    });
    // Still one turn, running: the agent is waiting, not finished.
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "running",
    ]);

    await personSays(linear, externalSessionId, "allow");
    const done = await itemReaches(session.id, "completed");
    expect((await itemsOf(session.id)).length).toBe(1);
    expect(done.answers.map((a) => a.body)).toEqual(["allow"]);
    const last = (await outbound(session.id)).at(-1);
    expect(last?.content).toEqual({
      type: "response",
      body: "Removed build/.",
    });
    await settle();
    expect((await finearSession(linear, token, externalSessionId)).status).toBe(
      "complete",
    );
  }, 60_000);

  test("LC-SIG-05 ask: free text rejects the call and becomes the next turn's request", async () => {
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Clean the build, carefully",
    );
    await until(async () =>
      (await outbound(session.id)).some((r) => r.contentType === "elicitation"),
    );
    await personSays(linear, externalSessionId, "run the tests instead");
    // No routing clock runs in the suites: route until the follow-up is
    // offered to the sticky runner, which claims and finishes it.
    await until(async () => {
      await route();
      const item = (await itemsOf(session.id))[1];
      return item?.status === "completed" ? item : null;
    }, 30_000);
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["session_created", "completed"],
      ["prompt", "completed"],
    ]);
    const responses = (await outbound(session.id))
      .filter((r) => r.contentType === "response")
      .map((r) => (r.content as { body: string }).body);
    expect(responses[0]).toBe("I did not remove build/.");
    expect(responses[1]).toContain(
      "<request>\nrun the tests instead\n</request>",
    );
    // The follow-up continued the agent's own session on the same runner.
    const sessionPrompts = home
      .received()
      .filter((r) => r.method === "session/load");
    expect(sessionPrompts.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("stop: the agent is cancelled, its process is gone, and the session says where it stopped", async () => {
    await playing("long", 120_000);
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "A long job",
    );
    await itemReaches(session.id, "running");
    const pid = await until(
      async () =>
        home
          .received()
          .find(
            (r) =>
              r.method === "session/prompt" && r.session === String(session.id),
          )?.pid,
    );
    expect(alive(pid)).toBe(true);
    await personSays(linear, externalSessionId, "Stop", "stop");
    const stopped = await itemReaches(session.id, "cancelled");
    expect(stopped.cancelReason).toBe("stop");
    // stop_grace is 2s in these homes.
    expect(alive(pid)).toBe(false);
    expect(home.received().map((r) => r.method)).toContain("session/cancel");
    const last = (await outbound(session.id)).at(-1);
    expect(last?.contentType).toBe("response");
    expect((last?.content as { body: string }).body).toStartWith(
      "Stopped at your request. Changes so far are on branch `hypotenuse/eng-",
    );
  }, 60_000);

  test("agents list shows the running session; agents kill stops it with an error saying so", async () => {
    await playing("long", 120_000);
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Kill me from the terminal",
    );
    await itemReaches(session.id, "running");
    const list = await home.run(["agents", "list", "--json"]);
    expect(list.code).toBe(0);
    const rows = JSON.parse(list.stdout).agents as {
      agentSessionId: number;
      state: string;
      pid: number | null;
      worktree: string | null;
    }[];
    const row = rows.find((r) => r.agentSessionId === session.id);
    expect(row?.state).toBe("running");
    expect(row?.pid).toBeGreaterThan(0);
    expect(row?.worktree).toStartWith(
      join(home.root, "worktrees", "web", "ENG-"),
    );

    const kill = await home.run([
      "agents",
      "kill",
      String(session.id),
      "--reason",
      "wrong approach",
    ]);
    expect(kill.code).toBe(0);
    await itemReaches(session.id, "cancelled");
    expect(alive(row?.pid as number)).toBe(false);
    const last = (await outbound(session.id)).at(-1);
    expect(last?.contentType).toBe("error");
    expect((last?.content as { body: string }).body).toStartWith(
      "Cancelled from runner acp-laptop (`hypotenuse agents kill`): wrong approach.",
    );
  }, 60_000);

  test("not logged in: the fix is named, and the agent is reported unavailable", async () => {
    await playing("auth-terminal");
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Needs a login",
    );
    const failed = await itemReaches(session.id, "failed");
    expect(failed.outcome?.error).toBe(
      "claude on runner acp-laptop is not logged in. On that machine, run: `hypotenuse agents login claude`",
    );
    expect((await outbound(session.id)).at(-1)?.content).toEqual({
      type: "error",
      body: "claude on runner acp-laptop is not logged in. On that machine, run: `hypotenuse agents login claude`",
    });
    const row = await until(async () => {
      const r = await runnerRow(home.runner.id);
      return r.agents?.[0]?.available === false ? r : null;
    });
    expect(row.agents).toEqual([
      expect.objectContaining({
        id: "claude",
        available: false,
        error: "not logged in",
      }),
    ]);
    // A reload (which `agents login` sends) is how a person says it is fixed.
    const reload = await home.run(["daemon", "reload", "--json"]);
    expect(reload.code).toBe(0);
    expect(JSON.parse(reload.stdout).applied).toContain("agents.availability");
    await until(async () => {
      const r = await runnerRow(home.runner.id);
      return r.agents?.[0]?.available === true ? r : null;
    });
  }, 60_000);
});
