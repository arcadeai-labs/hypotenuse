import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { enqueueNotification } from "../../ops/NotificationOps";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The tenancy guard on `project:<id>:notifications`.
 *
 * **This is the highest-risk code on the socket**, because the channel name
 * comes from the client: without the membership check any authenticated user
 * could subscribe to another tenant's channel and learn when its people are
 * being told something. There is no second gate behind it — a broadcast goes to
 * whoever is subscribed.
 *
 * Both halves of the refusal are asserted, and the second is the one that
 * matters: a subscribe that is *refused* but still delivers broadcasts would be
 * the actual leak, and a test that only checked the error message would pass
 * straight through it.
 */

let universe: TestUniverse;
let url: string;

/** A WebSocket against the running test server, plus its message log. */
async function openSocket(session?: string): Promise<{
  socket: WebSocket;
  messages: unknown[];
}> {
  const socket = new WebSocket(url.replace(/^http/, "ws"), {
    headers: session
      ? { Cookie: `${config.session.cookieName}=${session}` }
      : {},
  });
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  return { socket, messages };
}

/**
 * Subscribe, and report which answer came back.
 * @param socket - The open socket.
 * @param messages - Its message log.
 * @param channel - The channel to ask for.
 * @returns Whether the subscribe was accepted, and the error if it was not.
 */
async function subscribe(
  socket: WebSocket,
  messages: unknown[],
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  socket.send(JSON.stringify({ messageType: "subscribe", channel }));

  const deadline = Date.now() + 5_000;
  for (;;) {
    for (const raw of messages) {
      const message = raw as {
        subscribed?: { channel: string };
        error?: { message?: string };
      };
      if (message.subscribed?.channel === channel) return { ok: true };
      if (message.error) {
        return { ok: false, error: message.error.message };
      }
    }
    if (Date.now() > deadline) return { ok: false, error: "no answer" };
    await Bun.sleep(20);
  }
}

/** The notifications delivered on a socket so far. */
function delivered(messages: unknown[]): unknown[] {
  return messages.flatMap((raw) => {
    const frame = raw as { message?: { message?: string } };
    if (typeof frame.message?.message !== "string") return [];
    try {
      const payload = JSON.parse(frame.message.message) as { event?: string };
      return payload.event === "notifications" ? [payload] : [];
    } catch {
      return [];
    }
  });
}

/** Queue a notification for one user in the shared project. */
async function queueFor(user: TestUser): Promise<void> {
  await enqueueNotification(api.db.db, {
    projectId: universe.projectId,
    userIds: [user.userId],
    template: "test_channel",
    payload: { note: "Is this broadcast reaching the right subscriber?" },
    linkPath: "/settings/members",
    channels: ["browser"],
  });
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("project:<id>:notifications", () => {
  test("a member subscribes and receives a dispatched notification", async () => {
    const { socket, messages } = await openSocket(universe.peach.sessionId);
    try {
      const result = await subscribe(
        socket,
        messages,
        `project:${universe.projectId}:notifications`,
      );
      expect(result.ok).toBe(true);

      await queueFor(universe.peach);

      // **Dispatched by the ordinary task tick, not by calling deliver
      // directly.** That is what proves the Redis-backed path rather than a
      // shortcut: in the deployed topology the worker dispatches and the web
      // service holds the socket, so a broadcast that only worked in-process
      // would work perfectly here and never once fire in staging.
      await runAction("notifications:dispatch");

      const deadline = Date.now() + 5_000;
      while (delivered(messages).length === 0 && Date.now() < deadline) {
        await Bun.sleep(25);
      }

      const received = delivered(messages) as Record<string, unknown>[];
      expect(received.length).toBeGreaterThan(0);

      // **The frame's key set is exactly `{event}`** — no id, no recipient, no
      // content — and this is the assertion that keeps one shared per-project
      // channel safe. Content travels on `notification:list`, which checks
      // who is asking.
      for (const frame of received) {
        expect(Object.keys(frame)).toEqual(["event"]);
        expect(frame).toEqual({ event: "notifications" });
      }
    } finally {
      socket.close();
    }
  }, 20_000);

  test("a non-member is refused, and receives nothing after trying", async () => {
    // Bowser holds a valid session and no membership in Peach's project, which
    // is the exact shape of the leak: authenticated, and not entitled.
    const { socket, messages } = await openSocket(universe.bowser.sessionId);
    try {
      const result = await subscribe(
        socket,
        messages,
        `project:${universe.projectId}:notifications`,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not a member");

      await queueFor(universe.peach);
      await runAction("notifications:dispatch");
      // Long enough that a delivery would have landed — the member case above
      // is routinely under a second.
      await Bun.sleep(1_500);

      // The second half, and the one that would actually be the leak: a refused
      // subscribe that still delivered would pass a test asserting only the
      // error.
      expect(delivered(messages)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 20_000);

  test("an unauthenticated socket cannot subscribe at all", async () => {
    const { socket, messages } = await openSocket();
    try {
      const result = await subscribe(
        socket,
        messages,
        `project:${universe.projectId}:notifications`,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Sign in");
    } finally {
      socket.close();
    }
  }, 20_000);

  test("a malformed channel name is refused rather than throwing", async () => {
    const { socket, messages } = await openSocket(universe.peach.sessionId);
    try {
      // `project:abc:notifications` does not match the channel's own pattern,
      // so Keryx refuses it before the middleware sees it. Asserted anyway,
      // because the middleware's own guard against `Number(undefined)` is what
      // keeps this a refusal instead of a 500 if that routing ever changes.
      const result = await subscribe(
        socket,
        messages,
        "project:abc:notifications",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      socket.close();
    }
  }, 20_000);

  test("a member of one project cannot subscribe to another's", async () => {
    // Peach administers the shared project and Bowser administers his own, so
    // this is two legitimate users each reaching for the other's channel.
    const { socket, messages } = await openSocket(universe.peach.sessionId);
    try {
      const result = await subscribe(
        socket,
        messages,
        `project:${universe.bowser.projectId}:notifications`,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not a member");
    } finally {
      socket.close();
    }
  }, 20_000);
});
