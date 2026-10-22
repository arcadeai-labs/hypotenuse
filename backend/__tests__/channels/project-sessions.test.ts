import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { enqueueActivity } from "../../ops/ActivityOutboxOps";
import {
  broadcastSessionActivity,
  projectSessionsChannel,
  sessionFrameKey,
  sessionTrailingKey,
} from "../../ops/SessionChannelOps";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { settle } from "../linear/sessions";
import {
  delegatedSession,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  eventually,
  openSocket,
  subscribe,
  type TestSocket,
} from "../runners/helpers";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";

/**
 * `project:<id>:sessions` — the dashboard's wake-up call for agent sessions.
 * Only members subscribe; frames are exactly `{event}` or `{event, id}`;
 * every change a session can go through publishes after commit; and a burst
 * of activity collapses to a handful of frames.
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
let watcher: TestSocket;
let channel: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "sessions-channel-laptop",
    { limits: { maxParallelJobs: 5 } },
  );
  channel = projectSessionsChannel(universe.projectId);
  watcher = await openSocket(universe.url, universe.luigi.sessionId);
  expect((await subscribe(watcher, channel)).ok).toBe(true);
}, HOOK_TIMEOUT);
afterAll(() => watcher?.socket.close());

/**
 * Every frame published on a channel and delivered to a socket so far, parsed.
 * @param s - The socket.
 * @param name - The channel.
 * @returns The frames, in order.
 */
function payloads(s: TestSocket, name: string): Record<string, unknown>[] {
  return s.messages.flatMap((raw) => {
    const m = raw.message as { channel?: string; message?: string } | undefined;
    if (m?.channel !== name || typeof m.message !== "string") return [];
    return [JSON.parse(m.message) as Record<string, unknown>];
  });
}

/**
 * How many frames named one session have arrived.
 * @param id - The session.
 * @returns The count.
 */
function framesFor(id: number): number {
  return payloads(watcher, channel).filter(
    (p) => p.event === "session" && p.id === id,
  ).length;
}

describe("subscribing", () => {
  test("a member may; an outsider, a stranger, and the wrong shape may not", async () => {
    const outsider = await openSocket(universe.url, universe.bowser.sessionId);
    const anonymous = await openSocket(universe.url);
    try {
      expect(await subscribe(outsider, channel)).toEqual({
        ok: false,
        error: "You are not a member of this project",
      });
      // The same refusal for a project that does not exist.
      expect(
        await subscribe(outsider, projectSessionsChannel(999_999)),
      ).toEqual({
        ok: false,
        error: "You are not a member of this project",
      });
      expect((await subscribe(anonymous, channel)).ok).toBe(false);
    } finally {
      outsider.socket.close();
      anonymous.socket.close();
    }
  });
});

describe("publishing", () => {
  test("a session's life publishes frames naming it, and only {event, id}", async () => {
    const { session, externalSessionId } = await delegatedSession(
      linear,
      appUserId,
      "Watched from the dashboard",
    );
    expect(externalSessionId).toBeTruthy();
    // Created (and acknowledged) wakes the dashboard.
    expect(await eventually(() => framesFor(session.id) > 0)).toBe(true);

    await laptop.heartbeat();
    await runAction("work:route");
    const before = framesFor(session.id);
    const turn = await laptop.claim();
    expect(turn?.agentSessionId).toBe(session.id);
    expect(await eventually(() => framesFor(session.id) > before)).toBe(true);

    const afterClaim = framesFor(session.id);
    await laptop.events(turn!.workItemId, [
      { type: "thought", body: "Reading the code" },
    ]);
    expect(await eventually(() => framesFor(session.id) > afterClaim)).toBe(
      true,
    );

    const afterEvents = framesFor(session.id);
    await laptop.complete(turn!.workItemId, "completed");
    expect(await eventually(() => framesFor(session.id) > afterEvents)).toBe(
      true,
    );
    await settle();

    // Keryx's own presence frames (`presenceKey`) share the channel; ours
    // are the rest.
    const ours = payloads(watcher, channel).filter(
      (p) => !("presenceKey" in p),
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const frame of ours) {
      const keys = Object.keys(frame).sort();
      expect(["event", "event,id"]).toContain(keys.join(","));
      if (keys.length === 1) expect(frame.event).toBe("sessions");
      else expect(frame.event).toBe("session");
    }
  });

  test("a burst of fifty activities is a handful of frames, and the last one is not lost", async () => {
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "A chatty agent",
    );
    await settle();
    await api.redis.redis.del(
      sessionFrameKey(session.id),
      sessionTrailingKey(session.id),
    );
    const before = framesFor(session.id);
    for (let i = 0; i < 50; i++) {
      await api.db.db.transaction((tx) =>
        enqueueActivity(tx, session.id, {
          type: "thought",
          body: `Thought ${i}`,
        }),
      );
      await runAction("activities:deliver", { agentSessionId: session.id });
    }
    await Bun.sleep(200);
    const published = framesFor(session.id) - before;
    expect(published).toBeGreaterThanOrEqual(1);
    expect(published).toBeLessThanOrEqual(5);
    // The burst's tail is folded into one trailing frame, already scheduled.
    expect(await api.redis.redis.exists(sessionTrailingKey(session.id))).toBe(
      1,
    );
    const tail = framesFor(session.id);
    await runAction("sessions:broadcast", { agentSessionId: session.id });
    expect(await eventually(() => framesFor(session.id) > tail)).toBe(true);
  });

  test("a frame window is per session, and publishing never throws", async () => {
    await api.redis.redis.del(sessionFrameKey(424_242));
    // No such session: nothing to publish, and nothing thrown.
    await broadcastSessionActivity(424_242);
    expect(await api.redis.redis.exists(sessionFrameKey(424_242))).toBe(1);
  });
});
