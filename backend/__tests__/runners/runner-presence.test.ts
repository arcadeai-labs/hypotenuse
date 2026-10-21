import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { runners } from "../../schema/runners";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { heartbeat, heartbeatBody, registerRunner, runnerRow } from "./helpers";

/**
 * Presence is heartbeats, and time is a column: a beat older than
 * `runners.offlineAfterMs` is written, then the reaper runs.
 */

let universe: TestUniverse;
let url: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Move a runner's last heartbeat into the past.
 * @param id - The runner.
 * @param agoMs - How long ago.
 */
async function lastBeat(id: number, agoMs: number): Promise<void> {
  await api.db.db
    .update(runners)
    .set({ lastHeartbeatAt: new Date(Date.now() - agoMs) })
    .where(eq(runners.id, id));
}

describe("work:reap", () => {
  test("a runner silent past offlineAfterMs goes offline; a heartbeat brings it back", async () => {
    const runner = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "napper",
    );
    const machineId = `sha256:${"d1".repeat(16)}`;
    await heartbeat(url, runner.token, heartbeatBody({ machineId }));
    expect((await runnerRow(runner.id)).status).toBe("online");

    await lastBeat(runner.id, config.runners.offlineAfterMs - 5_000);
    await runAction("work:reap");
    expect((await runnerRow(runner.id)).status).toBe("online");

    await lastBeat(runner.id, config.runners.offlineAfterMs + 1_000);
    const reaped = await runAction<{ offline: number[] }>("work:reap");
    expect(reaped.offline).toContain(runner.id);
    expect((await runnerRow(runner.id)).status).toBe("offline");

    await heartbeat(url, runner.token, heartbeatBody({ machineId }));
    expect((await runnerRow(runner.id)).status).toBe("online");
  });

  test("a draining runner lapses the same way; revoked and never-seen runners are left alone", async () => {
    const draining = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "drowsy",
    );
    await heartbeat(url, draining.token, heartbeatBody({ draining: true }));
    await lastBeat(draining.id, config.runners.offlineAfterMs + 1_000);

    const never = await registerRunner(
      url,
      universe.toad,
      universe.projectId,
      "never-seen",
    );
    await runAction("work:reap");
    expect((await runnerRow(draining.id)).status).toBe("offline");
    expect((await runnerRow(never.id)).status).toBe("offline");
  });

  test("is a clock: task-only, on the configured frequency", () => {
    const action = api.actions.actions.find((a) => a.name === "work:reap");
    expect(action?.web).toBeUndefined();
    expect(action?.task?.frequency).toBe(config.runners.reapFrequencyMs);
  });
});
