import { describe, expect, test } from "bun:test";
import { relativeTime } from "../components/NotificationBell";
import { appendToast, parseBroadcast } from "../context/NotificationContext";
import { helpRequestId } from "../utils/transcript";

/**
 * Wrap a payload the way the server and Keryx together put it on the wire.
 *
 * **Double-encoded, and that is the thing worth pinning.** `deliverBrowser`
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

describe("parseBroadcast", () => {
  test("reads the signal out of the doubly-wrapped frame", () => {
    const parsed = parseBroadcast(
      frame({ event: "notification", notification: { id: 3, userId: 7 } }),
    );
    expect(parsed).toEqual({ id: 3, userId: 7 });
  });

  test("keeps only the id and the recipient, never content", () => {
    // The frame is content-free by design on the server, and this is the second
    // half of that: even if something ever published more, the client would not
    // read it. A restricted question must not become renderable just because it
    // arrived on a channel every project member may subscribe to.
    const parsed = parseBroadcast(
      frame({
        event: "notification",
        notification: {
          id: 3,
          userId: 7,
          title: "An agent needs an answer",
          body: "Which environment should I deploy to?",
          payload: { question: "a restricted question" },
        },
      }),
    );
    expect(parsed).toEqual({ id: 3, userId: 7 });
    expect(JSON.stringify(parsed)).not.toContain("restricted");
  });

  test("drops a frame with no usable id or recipient", () => {
    expect(
      parseBroadcast(
        frame({ event: "notification", notification: { title: "hi" } }),
      ),
    ).toBeNull();
  });

  test("drops everything else on the socket without throwing", () => {
    // The same socket carries subscribe confirmations, presence join/leave
    // events, and action replies. None of them is a notification, and a reader
    // that threw on one would take the whole connection down.
    for (const other of [
      JSON.stringify({ subscribed: { channel: "project:1:notifications" } }),
      frame({ event: "join", presenceKey: "abc" }),
      frame({ nonsense: true }),
      '{"not":"json"',
      "",
      null,
      42,
    ]) {
      expect(parseBroadcast(other)).toBeNull();
    }
  });
});

describe("helpRequestId", () => {
  test("finds the request a status event refers to", () => {
    expect(
      helpRequestId({
        type: "status",
        payload: { status: "help_requested", requestId: 12 },
      }),
    ).toBe(12);
  });

  test("ignores every other status event and every other type", () => {
    // `toolexec:report-status` writes `status` events too, and the transcript
    // must keep rendering those as status lines rather than as empty questions.
    expect(
      helpRequestId({
        type: "status",
        payload: { status: "working", message: "cloning" },
      }),
    ).toBeNull();
    expect(helpRequestId({ type: "assistant", payload: null })).toBeNull();
    // `payload` is untyped `jsonb`, so a row written by an older deploy may be
    // missing the id entirely. That must read as "not a help event", not as a
    // crash on a history page.
    expect(
      helpRequestId({ type: "status", payload: { status: "help_requested" } }),
    ).toBeNull();
  });
});

describe("appendToast", () => {
  const toast = (id: number) => ({
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    linkPath: `/help?request=${id}`,
  });

  test("a repeated frame does not stack a second identical toast", () => {
    // Broadcast frames are explicitly best-effort, so a duplicate delivery is a
    // thing that happens. Without the id check the same question stacked twice
    // on screen until both timers expired, while the desktop notification
    // deduped for free from its `tag`.
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
