import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { settle } from "../linear/sessions";
import {
  delegatedSession,
  itemsOf,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, outbound, signed, until } from "./helpers";

/**
 * The whole loop with the real daemon: `hypotenuse daemon start
 * --foreground` heartbeats, subscribes to its channel, is woken by the routing
 * ping, claims the turn, runs the fake ACP agent through the agent host, and
 * its events land in `agent_activities` and in finear while the work item
 * reaches `completed`. `daemon status` answers over the control socket.
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
let home: DaemonHome;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
  );
  await home.startForeground();
}, HOOK_TIMEOUT);

describe("daemon loop", () => {
  test("the daemon comes online with its config's capabilities", async () => {
    const row = await until(async () => {
      const r = await runnerRow(home.runner.id);
      return r.status === "online" && r.limits ? r : null;
    });
    expect(row.limits).toEqual({ maxParallelJobs: 2 });
    expect(row.roles).toEqual(["worker"]);
    expect(row.agents).toEqual([
      expect.objectContaining({
        id: "claude",
        preset: "custom",
        available: true,
        roles: ["worker"],
      }),
    ]);
    expect(row.repositories).toEqual([
      { name: "web", remote: "github.com/acme/web", baseBranch: "main" },
    ]);
  });

  test("a delegated session is claimed, answered, and completed", async () => {
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Fix checkout rounding",
    );
    const done = await until(async () => {
      const [item] = await itemsOf(session.id);
      return item?.status === "completed" ? item : null;
    }, 20_000);
    expect(done.runnerId).toBe(home.runner.id);

    const rows = await outbound(session.id);
    const bodies = rows.map((r) => [
      r.contentType,
      (r.content as { body?: string }).body,
    ]);
    expect(bodies).toContainEqual([
      "thought",
      "Starting claude in `github.com/acme/web`…",
    ]);
    expect(bodies.at(-1)).toEqual([
      "response",
      signed("Fixed the rounding in `src/a.ts`.", "mario-laptop"),
    ]);
    await settle();
  }, 30_000);

  test("daemon status answers over a 0600 control socket", async () => {
    const socket = join(home.stateDir, "daemon.sock");
    expect(existsSync(socket)).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const { code, stdout } = await home.run(["daemon", "status", "--json"]);
    expect(code).toBe(0);
    const status = JSON.parse(stdout);
    expect(status).toMatchObject({
      running: true,
      runner: {
        id: home.runner.id,
        name: "mario-laptop",
        projectId: universe.projectId,
      },
      server: { url: home.url, connected: true, socket: "open" },
      slots: { total: 2, busy: 0 },
      draining: false,
    });
  });

  test("daemon stop drains and exits; status then says not running (exit 3)", async () => {
    const stop = await home.run(["daemon", "stop"]);
    expect(stop.code).toBe(0);
    expect(await home.proc?.exited).toBe(143);
    const status = await home.run(["daemon", "status", "--json"]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout)).toEqual({ running: false });
  });
});
