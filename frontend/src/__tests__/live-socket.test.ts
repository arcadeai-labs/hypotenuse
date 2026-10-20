import { describe, expect, test } from "bun:test";
import {
  createChannelRegistry,
  isLiveSocket,
  isRunsPayload,
  parseRunPayload,
  parseSocketEnvelope,
} from "../context/LiveSocketContext";

/**
 * Wrap a payload the way the server and Keryx together put it on the wire.
 * @param channel - The channel name.
 * @param inner - What the publisher broadcast.
 * @returns The raw frame `data` a browser sees.
 */
function frame(channel: string, inner: unknown): string {
  return JSON.stringify({
    message: {
      channel,
      message: JSON.stringify(inner),
      sender: "run:update",
    },
  });
}

describe("parseSocketEnvelope", () => {
  test("unwraps the doubly-encoded PubSub frame", () => {
    expect(
      parseSocketEnvelope(
        frame("project:1:run:2", { event: "run", run: { id: 2 } }),
      ),
    ).toEqual({
      channel: "project:1:run:2",
      payload: { event: "run", run: { id: 2 } },
    });
  });

  test("drops subscribe confirmations and presence without throwing", () => {
    expect(
      parseSocketEnvelope(
        JSON.stringify({ subscribed: { channel: "project:1:runs" } }),
      ),
    ).toBeNull();
    expect(
      parseSocketEnvelope(
        JSON.stringify({
          message: { channel: "project:1:runs", message: "not-json" },
        }),
      ),
    ).toBeNull();
    expect(parseSocketEnvelope("")).toBeNull();
    expect(parseSocketEnvelope(null)).toBeNull();
  });
});

describe("parseRunPayload", () => {
  test("keeps the id, project, and kinds, never content", () => {
    const parsed = parseRunPayload({
      event: "run",
      run: {
        id: 11,
        projectId: 3,
        kinds: ["events"],
        text: "a restricted transcript line",
      },
    });
    expect(parsed).toEqual({
      runId: 11,
      projectId: 3,
      kinds: ["events"],
    });
    expect(JSON.stringify(parsed)).not.toContain("restricted");
  });

  test("drops unknown kinds and a frame with no usable id", () => {
    expect(
      parseRunPayload({
        event: "run",
        run: { id: 11, projectId: 3, kinds: ["events", "nope"] },
      })?.kinds,
    ).toEqual(["events"]);
    expect(parseRunPayload({ event: "run", run: { title: "hi" } })).toBeNull();
    expect(parseRunPayload({ event: "notification" })).toBeNull();
  });
});

describe("isRunsPayload", () => {
  test("accepts the content-free list ping and nothing else", () => {
    expect(isRunsPayload({ event: "runs" })).toBe(true);
    expect(isRunsPayload({ event: "run", run: { id: 1, projectId: 1 } })).toBe(
      false,
    );
    expect(isRunsPayload(null)).toBe(false);
  });
});

describe("isLiveSocket", () => {
  test("ignores a close from an older socket after a remount opened a new one", () => {
    const live = { url: "ws://live" } as WebSocket;
    const stale = { url: "ws://stale" } as WebSocket;
    expect(isLiveSocket(live, live)).toBe(true);
    expect(isLiveSocket(live, stale)).toBe(false);
    expect(isLiveSocket(null, stale)).toBe(false);
  });
});

describe("createChannelRegistry", () => {
  /**
   * Drain the deferred leave so assertions see the server-facing frames.
   */
  async function flush(): Promise<void> {
    await Promise.resolve();
  }

  test("a remount in the same turn does not unsubscribe", async () => {
    const sent: string[] = [];
    const { subscribe } = createChannelRegistry((type, channel) => {
      sent.push(`${type}:${channel}`);
    });
    const first = subscribe("project:1:runs", () => undefined);
    first();
    const second = subscribe("project:1:runs", () => undefined);
    await flush();
    expect(sent).toEqual(["subscribe:project:1:runs"]);
    second();
    await flush();
    expect(sent).toEqual([
      "subscribe:project:1:runs",
      "unsubscribe:project:1:runs",
    ]);
  });

  test("a real leave after the turn still unsubscribes", async () => {
    const sent: string[] = [];
    const { subscribe, activeChannels } = createChannelRegistry(
      (type, channel) => {
        sent.push(`${type}:${channel}`);
      },
    );
    const release = subscribe("project:1:runs", () => undefined);
    expect(activeChannels()).toEqual(["project:1:runs"]);
    release();
    expect(activeChannels()).toEqual([]);
    await flush();
    expect(sent).toEqual([
      "subscribe:project:1:runs",
      "unsubscribe:project:1:runs",
    ]);
  });

  test("dispatch reaches only handlers that still hold the channel", () => {
    const seen: unknown[] = [];
    const { subscribe, dispatch } = createChannelRegistry(() => undefined);
    const release = subscribe("project:1:runs", (payload) => {
      seen.push(payload);
    });
    dispatch("project:1:runs", { event: "runs" });
    release();
    dispatch("project:1:runs", { event: "runs" });
    expect(seen).toEqual([{ event: "runs" }]);
  });
});
