import { describe, expect, test } from "bun:test";
import {
  createChannelRegistry,
  isLiveSocket,
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
      sender: "notifications:dispatch",
    },
  });
}

describe("parseSocketEnvelope", () => {
  test("unwraps the doubly-encoded PubSub frame", () => {
    expect(
      parseSocketEnvelope(
        frame("project:1:notifications", { event: "notifications" }),
      ),
    ).toEqual({
      channel: "project:1:notifications",
      payload: { event: "notifications" },
    });
  });

  test("drops subscribe confirmations and presence without throwing", () => {
    expect(
      parseSocketEnvelope(
        JSON.stringify({ subscribed: { channel: "project:1:notifications" } }),
      ),
    ).toBeNull();
    expect(
      parseSocketEnvelope(
        JSON.stringify({
          message: { channel: "project:1:notifications", message: "not-json" },
        }),
      ),
    ).toBeNull();
    expect(parseSocketEnvelope("")).toBeNull();
    expect(parseSocketEnvelope(null)).toBeNull();
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
    const first = subscribe("project:1:notifications", () => undefined);
    first();
    const second = subscribe("project:1:notifications", () => undefined);
    await flush();
    expect(sent).toEqual(["subscribe:project:1:notifications"]);
    second();
    await flush();
    expect(sent).toEqual([
      "subscribe:project:1:notifications",
      "unsubscribe:project:1:notifications",
    ]);
  });

  test("a real leave after the turn still unsubscribes", async () => {
    const sent: string[] = [];
    const { subscribe, activeChannels } = createChannelRegistry(
      (type, channel) => {
        sent.push(`${type}:${channel}`);
      },
    );
    const release = subscribe("project:1:notifications", () => undefined);
    expect(activeChannels()).toEqual(["project:1:notifications"]);
    release();
    expect(activeChannels()).toEqual([]);
    await flush();
    expect(sent).toEqual([
      "subscribe:project:1:notifications",
      "unsubscribe:project:1:notifications",
    ]);
  });

  test("dispatch reaches only handlers that still hold the channel", () => {
    const seen: unknown[] = [];
    const { subscribe, dispatch } = createChannelRegistry(() => undefined);
    const release = subscribe("project:1:notifications", (payload) => {
      seen.push(payload);
    });
    dispatch("project:1:notifications", { event: "notifications" });
    release();
    dispatch("project:1:notifications", { event: "notifications" });
    expect(seen).toEqual([{ event: "notifications" }]);
  });
});
