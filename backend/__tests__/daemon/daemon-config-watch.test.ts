import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { api } from "keryx";
import { withoutRunnerRateLimits } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, until } from "./helpers";

/**
 * The daemon watches its config file. An edit it can apply is reloaded as
 * `daemon reload` would; an invalid one is refused and the running config
 * stays; one only a restart can apply drains and re-executes the daemon,
 * which comes back on the new config.
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
  await home?.run(["daemon", "stop", "--force"]);
  await home?.kill("SIGKILL");
  await api.stop();
}, HOOK_TIMEOUT);

withoutRunnerRateLimits();

/**
 * Rewrite the config file.
 * @param edit - From the current text to the next.
 */
function editConfig(edit: (text: string) => string): void {
  writeFileSync(home.configPath, edit(readFileSync(home.configPath, "utf8")));
}

/**
 * How many times a line occurs in the daemon log.
 * @param pattern - The line.
 * @returns The count.
 */
function count(pattern: RegExp): number {
  return home.log().match(new RegExp(pattern, "g"))?.length ?? 0;
}

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
  }, 90_000);
});
