import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  delegatedSession,
  itemsOf,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, outbound, until } from "./helpers";

/**
 * Stopping a daemon mid-turn. Plain `daemon stop` claims nothing more and
 * lets the running turn finish before the process exits; `--cancel` with a
 * short timeout stops it instead, and the turn ends `cancelled` with a final
 * response saying so.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill("SIGKILL");
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
    "drainer",
    { turnMs: 3_000 },
  );
}, HOOK_TIMEOUT);

/**
 * Delegate an issue and wait until the daemon holds its turn.
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

describe("drain", () => {
  test("daemon stop lets the running turn finish, then exits", async () => {
    await home.startForeground();
    const session = await runningTurn("Drain me gently");
    const stop = await home.run(["daemon", "stop"]);
    expect(stop.code).toBe(0);
    const [item] = await itemsOf(session.id);
    expect(item?.status).toBe("completed");
    expect(await home.proc?.exited).toBe(143);
    home.proc = null;
  }, 30_000);

  test("daemon stop --timeout 1s --cancel ends the turn cancelled, saying the runner shut down", async () => {
    home = new DaemonHome(
      home.root,
      home.url,
      home.runner,
      home.machine,
      60_000,
    );
    await home.startForeground();
    const session = await runningTurn("Drain me firmly");
    const stop = await home.run([
      "daemon",
      "stop",
      "--timeout",
      "1s",
      "--cancel",
    ]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("1 running turn(s) were stopped");
    const [item] = await itemsOf(session.id);
    expect(item?.status).toBe("cancelled");
    const last = (await outbound(session.id)).at(-1);
    expect(last?.contentType).toBe("error");
    expect((last?.content as { body: string }).body).toBe(
      "The runner drainer shut down mid-turn. Reply to continue (it may resume on another runner).",
    );
    expect(await home.proc?.exited).toBe(143);
    home.proc = null;
  }, 30_000);
});
