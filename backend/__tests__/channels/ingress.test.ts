import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { botInstallations } from "../../schema/bot_installations";
import { conversationInbox } from "../../schema/conversation_inbox";
import { triggerEvents } from "../../schema/trigger_events";
import { clearLoopQueues } from "../agent/harness";
import { HOOK_TIMEOUT } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  resetChannels,
  settle,
} from "./harness";

/**
 * Ingress: verify first, answer within the platform's clock, dedupe on the
 * message, and refuse every routing or signature failure with one
 * byte-identical 404.
 */
let stage: ChannelStage;

beforeAll(async () => {
  stage = await buildChannelStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetChannels();
  stage.platform.timestamp = null;
  stage.platform.signWith = null;
  stage.models.reset();
  stage.platform.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

const message = {
  channel: { id: "C-general", name: "general" },
  conversation: "T-in",
  text: "Hello?",
  mentions: true,
};

/**
 * Post a raw body and keep everything a prober could compare.
 * @param url - Where.
 * @param body - The body.
 * @param signature - The signature header.
 * @returns Status, content type, and body bytes.
 */
async function probe(url: string, body: string, signature?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "hypotenuse-signature": signature } : {}),
    },
    body,
  });
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    body: await res.text(),
  };
}

// Coverage: `webhook.in.signature`.
describe("ingress refuses byte-identically", () => {
  test("unknown key, bad signature, stale timestamp, no signature, and a pending installation are one 404", async () => {
    const body = JSON.stringify({
      ...message,
      messageId: "m1",
      sender: { id: "U" },
    });
    const unknown = await probe(
      `${stage.u.url}/api/webhooks/webhook/hyp_rk_doesnotexist`,
      body,
      "t=1,v1=00",
    );
    expect(unknown).toEqual({
      status: 404,
      type: "application/json",
      body: '{"error":"not found"}\n',
    });
    const unsigned = await probe(stage.platform.eventsUrl, body);
    stage.platform.signWith = "a-different-secret-entirely";
    const forged = await stage.platform.sendRaw(body);
    stage.platform.signWith = null;
    stage.platform.timestamp = Math.floor(Date.now() / 1000) - 3600;
    const stale = await stage.platform.sendRaw(body);
    stage.platform.timestamp = null;
    await api.db.db
      .update(botInstallations)
      .set({ status: "pending" })
      .where(eq(botInstallations.id, stage.installationId));
    const pending = await stage.platform.sendRaw(body);
    for (const refusal of [
      unsigned,
      { ...forged, type: "application/json" },
      { ...stale, type: "application/json" },
      { ...pending, type: "application/json" },
    ]) {
      expect(refusal).toEqual(unknown);
    }
    expect(await api.db.db.select().from(triggerEvents)).toHaveLength(0);
  });

  test("a body past the cap is refused before it is read in full", async () => {
    const cap = config.platforms.maxBodyBytes;
    config.platforms.maxBodyBytes = 100;
    try {
      const res = await stage.platform.send({
        ...message,
        text: "x".repeat(500),
      });
      expect(res.status).toBe(413);
    } finally {
      config.platforms.maxBodyBytes = cap;
    }
  });
});

// Coverage: `webhook.in.dedupe`.
describe("ingress answers fast and dedupes", () => {
  test("twenty concurrent deliveries are each answered within 200 ms", async () => {
    const timings = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const started = performance.now();
        const res = await stage.platform.send({
          ...message,
          conversation: `T-${i}`,
        });
        return { status: res.status, ms: performance.now() - started };
      }),
    );
    expect(timings.every((t) => t.status === 200)).toBe(true);
    expect(Math.max(...timings.map((t) => t.ms))).toBeLessThan(200);
    // Nothing ran inline: every event waits for its job.
    const events = await api.db.db.select().from(triggerEvents);
    expect(events.every((e) => e.status === "pending")).toBe(true);
  });

  test("a retried delivery is one event; two events carrying one message are one inbox row", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Once." } }] },
    ]);
    const first = { ...message, messageId: "same", eventId: "evt-1" };
    await stage.platform.send(first);
    await stage.platform.send(first);
    await stage.platform.send({ ...first, eventId: "evt-2" });
    expect(await api.db.db.select().from(triggerEvents)).toHaveLength(2);
    await settle();
    const inbox = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.deliveryKey, "C-general:same"));
    expect(inbox).toHaveLength(1);
    const outcomes = (await api.db.db.select().from(triggerEvents))
      .map((e) => e.outcome)
      .sort();
    expect(outcomes).toEqual(["duplicate", "message"]);
  });

  test("the sweep processes an event whose job was lost", async () => {
    await stage.platform.send({ ...message, conversation: "T-lost" });
    await api.resque.queue.delQueue("ingress");
    await api.db.db
      .update(triggerEvents)
      .set({ checkAfter: new Date(Date.now() - 1000) });
    const { runAction } = await import("../setup");
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Found." } }] },
    ]);
    const swept = await runAction<{ processed: number }>(
      "triggers:process-pending",
    );
    expect(swept.processed).toBe(1);
    const [event] = await api.db.db.select().from(triggerEvents);
    expect(event.status).toBe("processed");
  });
});
