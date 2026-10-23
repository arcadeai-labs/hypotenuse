import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  delegatedSession,
  itemsOf,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, until } from "./helpers";

/**
 * The daemon watches its config file. An edit it can apply is reloaded as
 * `daemon reload` would; an invalid one is refused and the running config
 * stays; one only a restart can apply drains and re-executes the daemon,
 * which comes back on the new config. While a restart waits for a running
 * turn, an invalid save calls it off (and the daemon claims again), and a
 * `daemon stop` wins: nothing comes back.
 */

let universe: TestUniverse;
let home: DaemonHome;
beforeAll(async () => {
  universe = await buildTestUniverse();
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "watcher",
  );
}, HOOK_TIMEOUT);
afterAll(async () => {
  for (const h of [home, busy]) {
    await h?.run(["daemon", "stop", "--force"]);
    await h?.kill("SIGKILL");
  }
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

/** A daemon whose turns run a minute, so a restart has something to wait for. */
let busy: DaemonHome;
let appUserId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  busy = await DaemonHome.create(
    universe.url,
    universe.luigi,
    universe.projectId,
    "busy",
    { turnMs: 60_000 },
  );
}, HOOK_TIMEOUT);

/**
 * Rewrite a home's config file.
 * @param edit - From the current text to the next.
 * @param on - Whose; the first daemon's by default.
 */
function editConfig(
  edit: (text: string) => string,
  on: DaemonHome = home,
): void {
  writeFileSync(on.configPath, edit(readFileSync(on.configPath, "utf8")));
}

/**
 * How many times a line occurs in a daemon log.
 * @param pattern - The line.
 * @param on - Whose; the first daemon's by default.
 * @returns The count.
 */
function count(pattern: RegExp, on: DaemonHome = home): number {
  return on.log().match(new RegExp(pattern, "g"))?.length ?? 0;
}

/**
 * Delegate an issue and wait until the busy daemon holds its turn.
 * @param title - The issue title.
 * @returns The session.
 */
async function runningTurn(title: string) {
  const { session } = await delegatedSession(linear, appUserId, title);
  await until(async () => {
    const [item] = await itemsOf(session.id);
    return item && (item.status === "claimed" || item.status === "running");
  });
  return session;
}

/** A restart-only edit: naming the runner's own project. */
const nameProject = (t: string) =>
  t.replace("[server]\n", `[server]\nproject = "${universe.projectId}"\n`);

describe("config file watch", () => {
  test("a live edit reloads, an invalid one is refused, a restart-only one restarts", async () => {
    await home.startForeground();
    await until(
      async () => (await runnerRow(home.runner.id)).status === "online",
    );
    const firstPid = home.proc!.pid;

    editConfig((t) =>
      t.replace("[sessions]\n", '[sessions]\ncleanup_grace = "5m"\n'),
    );
    await home.waitForLog(/applied=[^ ]*sessions\.cleanup_grace/);
    expect(home.proc!.exitCode).toBeNull();

    editConfig((t) =>
      t.replace("max_parallel_jobs = 2", "max_parallel_jobs = -1"),
    );
    await home.waitForLog(/reload refused; the running config stays/);
    expect(home.proc!.exitCode).toBeNull();
    editConfig((t) =>
      t.replace("max_parallel_jobs = -1", "max_parallel_jobs = 2"),
    );

    // Naming the runner's own project changes nothing on the server, but only
    // a restart can apply it.
    editConfig((t) =>
      t.replace("[server]\n", `[server]\nproject = "${universe.projectId}"\n`),
    );
    await home.waitForLog(/restarting to apply the config change/);
    expect(await home.proc!.exited).toBe(0);
    home.proc = null;
    await until(async () => count(/daemon ready/) >= 2 || null, 20_000);

    const status = await home.run(["--json", "daemon", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).pid).not.toBe(firstPid);
    await until(
      async () => (await runnerRow(home.runner.id)).status === "online",
    );
    // Off the stage: the turns below belong to the busy daemon.
    expect((await home.run(["daemon", "stop"])).code).toBe(0);
  }, 90_000);
});

describe("a restart waiting for a running turn", () => {
  test("an invalid save calls it off; the daemon stays up and claims again", async () => {
    await busy.startForeground();
    await runningTurn("Hold the restart");
    editConfig(nameProject, busy);
    await busy.waitForLog(/once running turns finish/);
    await until(
      async () => (await runnerRow(busy.runner.id)).status === "draining",
    );

    editConfig(
      (t) => t.replace("max_parallel_jobs = 2", "max_parallel_jobs = -1"),
      busy,
    );
    await busy.waitForLog(/config restart called off: .* is not valid now/);
    await until(
      async () => (await runnerRow(busy.runner.id)).status === "online",
    );
    expect(busy.proc!.exitCode).toBeNull();
    expect(count(/re-executing/, busy)).toBe(0);
  }, 60_000);

  test("daemon stop during the wait wins: it exits and nothing comes back", async () => {
    editConfig(
      (t) => t.replace("max_parallel_jobs = -1", "max_parallel_jobs = 2"),
      busy,
    );
    // The file still names the project, so the fixed save waits to restart again.
    await until(
      async () => count(/once running turns finish/, busy) >= 2 || null,
    );

    const stop = await busy.run([
      "daemon",
      "stop",
      "--timeout",
      "1s",
      "--cancel",
    ]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(await busy.proc!.exited).toBe(143);
    busy.proc = null;
    expect(busy.log()).toContain(
      "config restart called off: a stop or restart was asked for",
    );
    // Past the restart's 50 ms hand-off and a re-executed daemon's start.
    await Bun.sleep(2_000);
    expect(count(/re-executing/, busy)).toBe(0);
    expect((await busy.run(["daemon", "status"])).code).toBe(3);
  }, 60_000);
});
