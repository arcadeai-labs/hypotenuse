import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MACHINE_IN_USE } from "@hypotenuse/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { api } from "keryx";
import { runners } from "../../schema/runners";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import {
  connect,
  heartbeat,
  heartbeatBody,
  registerRunner,
  runnerRow,
} from "./helpers";

/**
 * One daemon per machine, held by the server: a second live runner with an
 * online or draining runner's `machineId` is refused with a 409 naming it,
 * and nothing is written — whether it heartbeats or connects first, and when
 * several start at once.
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

/** A fresh machine id per test. */
function machine(): string {
  return `sha256:${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Read a 409.
 * @param res - The response.
 * @returns The error body.
 */
async function conflictOf(res: Response) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: {
      type: string;
      runnerId: number | null;
      runnerName: string | null;
      message: string;
    };
  };
  expect(body.error.type).toBe(MACHINE_IN_USE);
  return body.error;
}

describe("one live runner per machine", () => {
  test("a second runner heartbeating or connecting is refused, naming the first, nothing written", async () => {
    const id = machine();
    const first = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "first",
    );
    const second = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "second",
    );
    expect(
      (await heartbeat(url, first.token, heartbeatBody({ machineId: id })))
        .status,
    ).toBe(200);

    const byBeat = await conflictOf(
      await heartbeat(url, second.token, heartbeatBody({ machineId: id })),
    );
    expect(byBeat).toMatchObject({ runnerId: first.id, runnerName: "first" });
    const byConnect = await conflictOf(await connect(url, second.token, id));
    expect(byConnect.runnerId).toBe(first.id);

    const row = await runnerRow(second.id);
    expect(row).toMatchObject({
      status: "offline",
      lastHeartbeatAt: null,
      lastConnectedAt: null,
      machineId: null,
    });
  });

  test("still refused while the first is draining", async () => {
    const id = machine();
    const first = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "drainer",
    );
    const second = await registerRunner(
      url,
      universe.toad,
      universe.projectId,
      "waiter",
    );
    await heartbeat(
      url,
      first.token,
      heartbeatBody({ machineId: id, draining: true }),
    );
    expect((await runnerRow(first.id)).status).toBe("draining");
    await conflictOf(
      await heartbeat(url, second.token, heartbeatBody({ machineId: id })),
    );
    await conflictOf(await connect(url, second.token, id));
  });

  test("the same runner reconnecting and re-beating is fine", async () => {
    const id = machine();
    const runner = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "steady",
    );
    for (let i = 0; i < 2; i++) {
      expect((await connect(url, runner.token, id)).status).toBe(200);
      expect(
        (await heartbeat(url, runner.token, heartbeatBody({ machineId: id })))
          .status,
      ).toBe(200);
    }
  });

  test("once the first goes offline, the second may connect and beat", async () => {
    const id = machine();
    const first = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "sleeper",
    );
    const second = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "successor",
    );
    await heartbeat(url, first.token, heartbeatBody({ machineId: id }));
    await conflictOf(await connect(url, second.token, id));

    // Time is a column, not a wait: the first's last beat is long ago.
    await api.db.db
      .update(runners)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runners.id, first.id));
    await runAction("work:reap");
    expect((await runnerRow(first.id)).status).toBe("offline");

    expect((await connect(url, second.token, id)).status).toBe(200);
    expect(
      (await heartbeat(url, second.token, heartbeatBody({ machineId: id })))
        .status,
    ).toBe(200);

    // And now the first is the one refused.
    await conflictOf(
      await heartbeat(url, first.token, heartbeatBody({ machineId: id })),
    );
  });

  test("concurrent first heartbeats from many runners on one machine leave exactly one online", async () => {
    const id = machine();
    const racers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        registerRunner(url, universe.peach, universe.projectId, `racer-${i}`),
      ),
    );
    const answers = await Promise.all(
      racers.map((r) =>
        heartbeat(url, r.token, heartbeatBody({ machineId: id })),
      ),
    );
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(racers.length - 1);

    const live = await api.db.db
      .select({ id: runners.id })
      .from(runners)
      .where(
        and(
          eq(runners.machineId, id),
          inArray(runners.status, ["online", "draining"]),
        ),
      );
    expect(live).toHaveLength(1);
  });

  test("another tenant's runner on the machine is refused without being named", async () => {
    const id = machine();
    const mine = await registerRunner(
      url,
      universe.bowser,
      universe.bowser.projectId,
      "koopa-box",
    );
    const theirs = await registerRunner(
      url,
      universe.toad,
      universe.projectId,
      "toad-box",
    );
    await heartbeat(url, mine.token, heartbeatBody({ machineId: id }));
    const error = await conflictOf(
      await heartbeat(url, theirs.token, heartbeatBody({ machineId: id })),
    );
    expect(error).toMatchObject({ runnerId: null, runnerName: null });
    expect(error.message).not.toContain("koopa");
  });
});
