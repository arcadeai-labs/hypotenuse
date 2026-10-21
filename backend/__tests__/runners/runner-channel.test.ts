import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { isSocketAttached, runnerSessionsKey } from "../../ops/RunnerOps";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  connect,
  eventually,
  frames,
  openSocket,
  registerRunner,
  sessionCookie,
  subscribe,
  type TestRunner,
} from "./helpers";

let universe: TestUniverse;
let url: string;
let mine: TestRunner;
let other: TestRunner;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  mine = await registerRunner(url, universe.mario, universe.projectId, "mine");
  other = await registerRunner(
    url,
    universe.luigi,
    universe.projectId,
    "other",
  );
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Connect a runner and return the session its socket presents.
 * @param runner - The runner.
 * @returns The session id.
 */
async function sessionFor(runner: TestRunner): Promise<string> {
  const res = await connect(
    url,
    runner.token,
    `sha256:${crypto.randomUUID().replace(/-/g, "")}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { channel: string; runnerId: number };
  expect(body).toMatchObject({
    channel: `runner:${runner.id}`,
    runnerId: runner.id,
  });
  return sessionCookie(res);
}

describe("runner:<id>", () => {
  test("daemon:connect's cookie subscribes to its own channel, and presence follows the socket", async () => {
    const s = await openSocket(url, await sessionFor(mine));
    expect((await subscribe(s, `runner:${mine.id}`)).ok).toBe(true);
    expect(await isSocketAttached(mine.id)).toBe(true);
    s.socket.close();
    expect(
      await eventually(async () => !(await isSocketAttached(mine.id))),
    ).toBe(true);
  });

  test("the session minted is regenerated and recorded for revocation", async () => {
    const session = await sessionFor(mine);
    const tracked = await api.redis.redis.smembers(runnerSessionsKey(mine.id));
    expect(tracked).toContain(session);
  });

  test("another runner's channel is refused", async () => {
    const s = await openSocket(url, await sessionFor(mine));
    try {
      const result = await subscribe(s, `runner:${other.id}`);
      expect(result.ok).toBe(false);
    } finally {
      s.socket.close();
    }
  });

  test("a person's session is refused, even the owner's", async () => {
    for (const sessionId of [
      universe.mario.sessionId,
      universe.peach.sessionId,
    ]) {
      const s = await openSocket(url, sessionId);
      try {
        expect((await subscribe(s, `runner:${mine.id}`)).ok).toBe(false);
      } finally {
        s.socket.close();
      }
    }
  });

  test("revocation sends revoked, deletes the session, and the next subscribe fails", async () => {
    const target = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "doomed",
    );
    const session = await sessionFor(target);
    const s = await openSocket(url, session);
    try {
      const channel = `runner:${target.id}`;
      expect((await subscribe(s, channel)).ok).toBe(true);

      const res = await fetch(`${url}/api/runner/${target.id}`, {
        method: "DELETE",
        headers: authHeaders(universe.mario.sessionId),
        body: JSON.stringify({ projectId: universe.projectId }),
      });
      expect(res.status).toBe(200);

      expect(
        await eventually(() => frames(s, channel).includes("revoked")),
      ).toBe(true);
      expect(await api.redis.redis.exists(`session:${session}`)).toBe(0);
      expect(await api.redis.redis.exists(runnerSessionsKey(target.id))).toBe(
        0,
      );

      // The socket holds its session in memory; the row check refuses it.
      expect((await subscribe(s, channel)).ok).toBe(false);
      // And a new socket presenting the deleted cookie is nobody.
      const fresh = await openSocket(url, session);
      try {
        expect((await subscribe(fresh, channel)).ok).toBe(false);
      } finally {
        fresh.socket.close();
      }
    } finally {
      s.socket.close();
    }
  });
});

describe("project:<id>:runners", () => {
  test("members subscribe; outsiders and runners do not", async () => {
    const channel = `project:${universe.projectId}:runners`;
    const toad = await openSocket(url, universe.toad.sessionId);
    const bowser = await openSocket(url, universe.bowser.sessionId);
    const runner = await openSocket(url, await sessionFor(other));
    try {
      expect((await subscribe(toad, channel)).ok).toBe(true);
      expect((await subscribe(bowser, channel)).ok).toBe(false);
      expect((await subscribe(runner, channel)).ok).toBe(false);
    } finally {
      for (const s of [toad, bowser, runner]) s.socket.close();
    }
  });
});
