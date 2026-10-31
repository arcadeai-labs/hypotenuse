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
import { deliverConversation } from "../../ops/OutboxOps";
import { emit, emitStatus } from "../../ops/SurfaceOps";
import { outboxMessages } from "../../schema/outbox_messages";
import { clearLoopQueues, conversationRow, drainQueue } from "../agent/harness";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  conversationFor,
  outboxOf,
  resetChannels,
} from "./harness";

/**
 * The generalized outbox, through the webhook adapter and its fake: order
 * per conversation under a lease, supersession, refuse-at-enqueue, an
 * undeliverable reason, back-off that holds later rows, Retry-After, and a
 * lost response retried with the same delivery id.
 */
let stage: ChannelStage;
let defaults: typeof config.agents;

beforeAll(async () => {
  stage = await buildChannelStage();
  defaults = { ...config.agents };
}, HOOK_TIMEOUT);

afterEach(async () => {
  Object.assign(config.agents, defaults);
  await clearLoopQueues();
  await resetChannels();
  stage.models.reset();
  stage.platform.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A working conversation in #general with nothing delivered yet.
 * @param thread - The thread key.
 * @returns The conversation.
 */
async function working(thread: string) {
  await stage.platform.send({
    channel: { id: "C-general", name: "general" },
    conversation: thread,
    text: "Hello?",
    mentions: true,
  });
  await drainQueue("ingress");
  await api.resque.queue.delQueue("outbox");
  return conversationRow((await conversationFor(thread)).id);
}

/**
 * Write a final message row.
 * @param id - The conversation.
 * @param text - Its text.
 */
async function message(id: number, text: string) {
  return emit(api.db.db, await conversationRow(id), {
    kind: "message",
    payload: { messageKind: "reply", text },
  });
}

// Coverage: `webhook.out.retry`.
describe("delivery", () => {
  test("rows deliver in order, one deliverer at a time", async () => {
    const c = await working("T-order");
    for (const t of ["one", "two", "three"]) await message(c.id, t);
    const [a, b] = await Promise.all([
      deliverConversation(c.id),
      deliverConversation(c.id),
    ]);
    expect([a.leased, b.leased].sort()).toEqual([false, true]);
    const texts = stage.platform.deliveries
      .filter((d) => d.kind === "message")
      .map((d) => d.text);
    expect(texts).toEqual(["one", "two", "three"]);
    const ids = stage.platform.requests.map((r) =>
      Number(r.headers["hypotenuse-delivery"]),
    );
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
  });

  test("a final message supersedes the progress rows nobody has seen", async () => {
    const c = await working("T-sup");
    await emitStatus(api.db.db, c, "Searching memory…");
    await message(c.id, "Answer.");
    await deliverConversation(c.id);
    expect(stage.platform.deliveries.map((d) => d.kind)).toEqual(["message"]);
    const rows = await outboxOf(c.id);
    expect(
      rows
        .filter((r) => r.kind === "status")
        .every((r) => r.status === "superseded"),
    ).toBe(true);
  });

  test("a malformed row is refused where it is written", async () => {
    const c = await working("T-bad");
    await expect(
      emit(api.db.db, c, {
        kind: "message",
        payload: { messageKind: "reply", text: "" },
      }),
    ).rejects.toThrow("refused a message row: A message needs text.");
  });

  test("a 4xx is undeliverable, with the reason", async () => {
    const c = await working("T-gone");
    await message(c.id, "Gone.");
    stage.platform.answers.push({ status: 410 });
    await deliverConversation(c.id);
    const row = (await outboxOf(c.id)).at(-1);
    expect(row).toMatchObject({
      status: "undeliverable",
      error: "The receiver answered HTTP 410.",
    });
  });

  test("a 5xx backs off and holds the rows behind it; the retry sends both in order", async () => {
    config.agents.outboxRetryBaseMs = 60_000;
    const c = await working("T-back");
    await message(c.id, "first");
    await message(c.id, "second");
    stage.platform.answers.push({ status: 503 });
    await deliverConversation(c.id);
    let rows = (await outboxOf(c.id)).filter((r) => r.kind === "message");
    expect(rows.map((r) => r.status)).toEqual(["failed", "pending"]);
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 30_000,
    );
    await deliverConversation(c.id);
    // The held row was not attempted again.
    expect(stage.platform.deliveries).toHaveLength(1);
    await api.db.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(outboxMessages.id, rows[0].id));
    await runAction("outbox:deliver-due");
    rows = (await outboxOf(c.id)).filter((r) => r.kind === "message");
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent"]);
    // The 503 attempt was received too: the retry repeats it, same id, then the next.
    const seen = stage.platform.deliveries.map((d) => [d.deliveryId, d.text]);
    expect(seen).toEqual([
      [rows[0].id, "first"],
      [rows[0].id, "first"],
      [rows[1].id, "second"],
    ]);
  });

  test("a 429's Retry-After is honoured", async () => {
    config.agents.outboxRetryBaseMs = 0;
    const c = await working("T-429");
    await message(c.id, "later");
    stage.platform.answers.push({
      status: 429,
      headers: { "retry-after": "120" },
    });
    await deliverConversation(c.id);
    const row = (await outboxOf(c.id)).at(-1);
    expect(row?.status).toBe("failed");
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  test("a lost response is retried with the same delivery id, and the message id is recorded", async () => {
    config.agents.callbackTimeoutMs = 100;
    config.agents.outboxRetryBaseMs = 0;
    const c = await working("T-lost");
    await message(c.id, "again");
    stage.platform.answers.push({ lose: true, delayMs: 400 });
    await deliverConversation(c.id);
    const failed = (await outboxOf(c.id)).at(-1);
    expect(failed?.status).toBe("failed");
    await deliverConversation(c.id);
    const [first, second] = stage.platform.requests.filter(
      (r) => r.headers["hypotenuse-delivery"] !== "ping",
    );
    expect(first.headers["hypotenuse-delivery"]).toBe(
      second.headers["hypotenuse-delivery"],
    );
    expect(first.body).toBe(second.body);
    const sent = (await outboxOf(c.id)).at(-1);
    expect(sent?.status).toBe("sent");
    expect(sent?.externalMessageId).toMatch(/^ext-/);
  });
});
