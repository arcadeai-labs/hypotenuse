import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { runners } from "../../schema/runners";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { activityRows } from "../linear/sessions";
import { runnerRow } from "../runners/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  ago,
  delegatedSession,
  itemRow,
  itemsOf,
  reap,
  route,
  ScriptedDaemon,
  sessionById,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Leases: a claim stays a runner's while its heartbeats renew it; a lease
 * that lapses puts the turn back in the queue, sticky to the same runner, and
 * too many lapses fail it with an `error`. A runner that stops heartbeating
 * goes offline.
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
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * Let an item's lease lapse and run the reaper.
 * @param id - The item.
 * @returns What the reaper did.
 */
async function lapse(id: number) {
  await setItem(id, { leaseExpiresAt: ago(1000) });
  return reap();
}

describe("leases", () => {
  test("heartbeats renew the lease of every reported item the runner holds", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Renew me");
    const claimed = await laptop.claim();
    expect(claimed?.agentSessionId).toBe(session.id);
    const id = claimed!.workItemId;

    const soon = new Date(Date.now() + 1000);
    await setItem(id, { leaseExpiresAt: soon });
    const beat = await laptop.heartbeat();
    expect(beat.unknownActive).toEqual([]);
    expect((await itemRow(id)).leaseExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 30_000,
    );
    await laptop.complete(id, "completed");
  });

  test("a lapsed lease goes back to the queue, sticky, and the fourth lapse fails the turn", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Lose me");
    let claimed = await laptop.claim();
    const id = claimed!.workItemId;
    /**
     * Post one thought numbered from 1, as a daemon starting the turn does.
     * @param body - The thought.
     * @returns The status.
     */
    const firstEvent = async (body: string) =>
      (
        await laptop.rawEvents(id, [
          {
            eventId: crypto.randomUUID(),
            seq: 1,
            at: Date.now(),
            type: "thought",
            body,
            ephemeral: false,
          },
        ])
      ).status;
    expect(await firstEvent("Starting")).toBe(200);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const reaped = await lapse(id);
      expect(reaped.requeued).toEqual([id]);
      expect(await itemRow(id)).toMatchObject({
        status: "queued",
        attempts: attempt,
        runnerId: null,
        leaseExpiresAt: null,
      });
      // Stickiness survives: a laptop that slept should get its session back.
      expect((await sessionById(session.id)).runnerId).toBe(laptop.id);

      const beat = await laptop.heartbeat();
      expect(beat.unknownActive).toEqual([id]);
      expect(laptop.held.has(id)).toBe(false);

      await route();
      expect(await itemRow(id)).toMatchObject({
        status: "offered",
        offeredToRunnerId: laptop.id,
      });
      claimed = await laptop.claim([id]);
      expect(claimed).toMatchObject({ workItemId: id, fresh: false });
      // Sequence numbers are per claim: the retry numbers from 1 again.
      expect(await firstEvent(`Starting again, attempt ${attempt}`)).toBe(200);
    }

    const reaped = await lapse(id);
    expect(reaped.failed).toEqual([id]);
    expect(await itemRow(id)).toMatchObject({ status: "failed", attempts: 4 });
    const last = (await activityRows(session.id)).at(-1);
    expect(last).toMatchObject({ direction: "outbound", contentType: "error" });
    expect((last!.content as { body: string }).body).toContain("lost 4 times");
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "failed",
    ]);
  });

  test("a runner silent past offlineAfter goes offline", async () => {
    await api.db.db
      .update(runners)
      .set({ lastHeartbeatAt: ago(60_000) })
      .where(eq(runners.id, laptop.id));
    const reaped = await reap();
    expect((reaped as unknown as { offline: number[] }).offline).toEqual([
      laptop.id,
    ]);
    expect((await runnerRow(laptop.id)).status).toBe("offline");
    await laptop.heartbeat();
    expect((await runnerRow(laptop.id)).status).toBe("online");
  });
});
