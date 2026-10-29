import { describe, expect, test } from "bun:test";
import { relativeTime } from "../components/shell/NotificationBell";
import {
  type AppNotification,
  appendToast,
  applyRead,
  isNotificationsBroadcast,
  newArrivals,
  notificationsChannel,
} from "../context/NotificationContext";

/**
 * Wrap a payload the way the server and Keryx together put it on the wire.
 *
 * **Double-encoded, and that is the thing worth pinning.** The dispatcher
 * serializes our object to a string, and Keryx's web server then wraps the whole
 * PubSub message in `{ message: … }` and serializes that. A reader that unwrapped
 * one layer would get a string where it expected an object and drop every
 * notification silently — which looks exactly like a socket that is not
 * connected.
 * @param inner - What the dispatcher broadcast.
 * @returns The raw frame `data` a browser sees.
 */
function frame(inner: unknown): string {
  return JSON.stringify({
    message: {
      channel: "project:1:notifications",
      message: JSON.stringify(inner),
      sender: "notifications:dispatch",
    },
  });
}

describe("isNotificationsBroadcast", () => {
  test("reads the ping out of the doubly-wrapped frame", () => {
    expect(isNotificationsBroadcast(frame({ event: "notifications" }))).toBe(
      true,
    );
  });

  test("drops everything else on the socket without throwing", () => {
    // The same socket carries subscribe confirmations, presence join/leave
    // events, and action replies. None of them is a notification ping, and a
    // reader that threw on one would take the whole connection down.
    for (const other of [
      JSON.stringify({ subscribed: { channel: "project:1:notifications" } }),
      frame({ event: "join", presenceKey: "abc" }),
      frame({ nonsense: true }),
      '{"not":"json"',
      "",
      null,
      42,
    ]) {
      expect(isNotificationsBroadcast(other)).toBe(false);
    }
  });
});

describe("notificationsChannel", () => {
  test("matches the backend's channel pattern", () => {
    expect(notificationsChannel(12)).toMatch(/^project:(\d+):notifications$/);
  });
});

describe("newArrivals", () => {
  /**
   * A notification row as `notification:list` returns it.
   * @param id - Its id.
   * @param readAt - When it was read, or null.
   * @returns The row.
   */
  const row = (id: number, readAt: number | null = null) =>
    ({
      id,
      readAt,
      title: `title ${id}`,
      body: `body ${id}`,
      linkPath: "/settings",
    }) as unknown as AppNotification;

  test("the first read seeds the history and toasts nothing", () => {
    expect(newArrivals(null, [row(2), row(1)])).toEqual([]);
  });

  test("an unread row this tab has not seen is news, oldest first", () => {
    const arrived = newArrivals(new Set([1]), [row(3), row(2), row(1)]);
    expect(arrived.map((n) => n.id)).toEqual([2, 3]);
  });

  test("a row that is already read is never toasted", () => {
    expect(newArrivals(new Set([1]), [row(2, Date.now()), row(1)])).toEqual([]);
  });

  test("a read that was not applied changes nothing, so the backlog stays quiet", () => {
    // A superseded or failed read resolves null. Were it an empty first read,
    // the next real read would toast every unread row.
    const skipped = applyRead(null, null);
    expect(skipped).toEqual({ arrivals: [], seen: null });

    const first = applyRead(skipped.seen, [row(2), row(1)]);
    expect(first.arrivals).toEqual([]);
    expect([...(first.seen ?? [])].sort()).toEqual([1, 2]);

    const later = applyRead(first.seen, null);
    expect(later.seen).toBe(first.seen);

    const next = applyRead(later.seen, [row(3), row(2), row(1)]);
    expect(next.arrivals.map((n) => n.id)).toEqual([3]);
  });
});

describe("appendToast", () => {
  const toast = (id: number) => ({
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    linkPath: "/settings",
  });

  test("a repeated frame does not stack a second identical toast", () => {
    // Broadcast frames are explicitly best-effort, so a duplicate delivery is a
    // thing that happens. Without the id check the same notification would
    // stack twice until both timers expired.
    const once = appendToast([], toast(4));
    const twice = appendToast(once, toast(4));

    expect(once.map((t) => t.id)).toEqual([4]);
    expect(twice).toBe(once);
  });

  test("a different notification still gets its own toast", () => {
    const stacked = appendToast(appendToast([], toast(4)), toast(5));
    expect(stacked.map((t) => t.id)).toEqual([4, 5]);
  });
});

describe("relativeTime", () => {
  test("answers the question the list is actually asking", () => {
    const now = Date.now();
    expect(relativeTime(now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(now - 3 * 60 * 60_000)).toBe("3h ago");
    expect(relativeTime(now - 2 * 24 * 60 * 60_000)).toBe("2d ago");
  });
});
