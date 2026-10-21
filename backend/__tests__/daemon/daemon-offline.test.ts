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
import { ServerProxy } from "./proxy";

/**
 * The server vanishes mid-turn (the proxy the daemon talks through stops
 * accepting connections) and comes back. The turn keeps running; its events
 * queue in `state.db`, ephemeral ones superseding each other; on reconnect
 * every event that was queued arrives exactly once, in `seq` order, and the
 * completion lands after them.
 */

let universe: TestUniverse;
let proxy: ServerProxy;
beforeAll(async () => {
  universe = await buildTestUniverse();
  proxy = new ServerProxy(universe.url);
  proxy.up();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill("SIGKILL");
  proxy?.down();
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
    "on-a-train",
    {
      turnMs: 6_000,
      serverUrl: proxy.url,
    },
  );
}, HOOK_TIMEOUT);

/**
 * The events the daemon queued for a work item, from its debug log.
 * @param workItemId - The work item.
 * @returns `{ seq, ephemeral }` per event.
 */
function queued(workItemId: number): { seq: number; ephemeral: boolean }[] {
  return [
    ...home
      .log()
      .matchAll(
        new RegExp(
          `event queued .*workItem=${workItemId} .*seq=(\\d+) ephemeral=(true|false)`,
          "g",
        ),
      ),
  ].map((m) => ({ seq: Number(m[1]), ephemeral: m[2] === "true" }));
}

describe("offline queue", () => {
  test("events produced while the server is unreachable arrive once, in order, superseded ephemerals absent", async () => {
    await home.startForeground();
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Work through a tunnel",
    );
    const item = await until(async () => {
      const [row] = await itemsOf(session.id);
      return row && row.status === "running" ? row : null;
    }).catch((e) => {
      console.log(home.log());
      throw e;
    });

    proxy.down();
    await home.waitForLog(
      /lost the server|heartbeat failed|event flush failed/,
      10_000,
    );
    // Let the turn finish while the server is away: its ephemerals and its
    // response and completion all queue.
    await until(
      async () => queued(item.id).some((e) => !e.ephemeral && e.seq > 1),
      15_000,
    );
    proxy.up();

    const done = await until(async () => {
      const [row] = await itemsOf(session.id);
      return row?.status === "completed" ? row : null;
    }, 30_000);
    expect(done.id).toBe(item.id);

    const rows = (await outbound(session.id)).filter(
      (r) => r.contentType !== null,
    );
    const fromDaemon = rows.filter((r) =>
      /Holding this turn open|received this|no coding agent/.test(
        String((r.content as { body?: string }).body),
      ),
    );
    // Exactly once each: no client id twice.
    const ids = fromDaemon.map((r) => r.clientActivityId);
    expect(new Set(ids).size).toBe(ids.length);
    // In order: the received thought first, the response last.
    expect((fromDaemon[0]?.content as { body: string }).body).toContain(
      "received this",
    );
    expect(fromDaemon.at(-1)?.contentType).toBe("response");
    // Fewer ephemerals arrived than were produced: the offline ones superseded each other.
    const ephemeralQueued = queued(item.id).filter((e) => e.ephemeral).length;
    const ephemeralArrived = fromDaemon.filter((r) => r.ephemeral).length;
    expect(ephemeralQueued).toBeGreaterThan(ephemeralArrived);
    expect(home.log()).not.toContain("a daemon bug");
  }, 60_000);
});
