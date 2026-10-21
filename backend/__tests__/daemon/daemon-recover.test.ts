import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  ago,
  delegatedSession,
  itemsOf,
  reap,
  route,
  setItem,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, until } from "./helpers";

/**
 * A daemon killed with SIGKILL mid-turn leaves a stale lock and a turn it
 * cannot finish. Started again, it retakes the lock, reports the turn
 * `interrupted`, and does not claim it back on its own; once the lease lapses
 * the server re-offers the turn to this (sticky) runner, which runs it.
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
    "crashy",
    { turnMs: 60_000 },
  );
}, HOOK_TIMEOUT);

describe("recovery after kill -9", () => {
  test("the turn is reported interrupted and re-offered after its lease lapses", async () => {
    await home.startForeground();
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Survive a crash",
    );
    const claimed = await until(async () => {
      const [item] = await itemsOf(session.id);
      return item && item.status === "running" ? item : null;
    });

    expect(await home.kill("SIGKILL")).not.toBe(0);
    expect(existsSync(join(home.stateDir, "daemon.pid"))).toBe(true);

    home = new DaemonHome(home.root, home.url, home.runner, home.machine, 0);
    await home.startForeground();
    await home.waitForLog(
      new RegExp(`a turn was interrupted.*session=${session.id}`),
    );
    const db = new Database(join(home.stateDir, "state.db"), {
      readonly: true,
    });
    const row = db
      .query("SELECT state FROM local_sessions WHERE agent_session_id = ?")
      .get(session.id) as {
      state: string;
    };
    db.close();
    expect(row.state).toBe("interrupted");

    // The new process reports nothing for it, so the lease is not renewed.
    await setItem(claimed.id, { leaseExpiresAt: ago(1_000) });
    expect((await reap()).requeued).toContain(claimed.id);
    await route();
    const done = await until(async () => {
      const [item] = await itemsOf(session.id);
      return item?.status === "completed" ? item : null;
    }, 20_000);
    expect(done.runnerId).toBe(home.runner.id);
    expect(done.attempts).toBeGreaterThanOrEqual(1);
  }, 45_000);
});
