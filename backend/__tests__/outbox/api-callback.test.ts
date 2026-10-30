import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { BotRotateCallbackSecret } from "../../actions/bot/bot-rotate-callback-secret";
import {
  deliverOutboxMessage,
  verifyCallbackSignature,
} from "../../ops/OutboxOps";
import { outboxMessages } from "../../schema/outbox_messages";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  drainQueue,
  runTicks,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";

/**
 * The API channel's signed callback: every outbound message is an outbox row
 * written with its step, POSTed after commit with an HMAC signature a
 * receiver verifies, retried with the same delivery id when a response is
 * lost, and never sent to an address the SSRF guard refuses.
 */
let stage: AgentStage;
let secret: string;
let defaults: typeof config.agents;
let networkDefaults: typeof config.network;

/** What the receiver saw. */
interface Received {
  body: string;
  signature: string;
  delivery: string;
  valid: boolean;
}
const received: Received[] = [];
/** How the receiver answers the next requests: a status, or "slow" (past the timeout). */
const answers: (number | "slow")[] = [];

const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.text();
    const signature = req.headers.get("hypotenuse-signature") ?? "";
    received.push({
      body,
      signature,
      delivery: req.headers.get("hypotenuse-delivery") ?? "",
      valid: verifyCallbackSignature(secret, signature, body),
    });
    const answer = answers.shift() ?? 200;
    if (answer === "slow") await Bun.sleep(500);
    return new Response(null, { status: answer === "slow" ? 200 : answer });
  },
});
const hookUrl = `http://127.0.0.1:${receiver.port}/hook`;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.agents };
  networkDefaults = { ...config.network };
  const rotated = await call<ActionResponse<BotRotateCallbackSecret>>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}/callback-secret`,
  );
  secret = rotated.body.callbackSecret;
}, HOOK_TIMEOUT);

afterEach(async () => {
  Object.assign(config.agents, defaults);
  Object.assign(config.network, networkDefaults);
  await clearLoopQueues();
  stage.models.reset();
  received.length = 0;
  answers.length = 0;
});

afterAll(async () => {
  await receiver.stop(true);
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("the signed callback", () => {
  test("a reply is POSTed once, signed, and the receiver verifies it", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Signed." } }] },
    ]);
    const res = await startConversation(stage, "Call me back.", {
      callbackUrl: hookUrl,
    });
    const id = res.body.conversation.id;
    await runTicks();
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, id));
    expect(row.status).toBe("pending");
    expect(await drainQueue("outbox")).toEqual(["outbox:deliver"]);

    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(hit.valid).toBe(true);
    expect(hit.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(hit.delivery).toBe(String(row.id));
    expect(JSON.parse(hit.body)).toEqual({
      conversationId: id,
      entrySeq: row.seq,
      kind: "reply",
      text: "Signed.",
    });
    expect(
      verifyCallbackSignature("hyp_cbs_wrong", hit.signature, hit.body),
    ).toBe(false);
    const [sent] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, row.id));
    expect(sent.status).toBe("sent");
    expect(sent.attempts).toBe(1);
  });

  test("a question carries its options; a failed turn posts an error", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: { question: "Which?", options: ["A", "B"] },
          },
        ],
      },
    ]);
    await startConversation(stage, "Ask.", { callbackUrl: hookUrl });
    await runTicks();
    stage.models.play([{ text: "hm" }, { text: "hm" }]);
    await startConversation(stage, "Fail.", { callbackUrl: hookUrl });
    await runTicks();
    await drainQueue("outbox");
    const bodies = received.map((r) => JSON.parse(r.body));
    expect(bodies[0]).toMatchObject({
      kind: "question",
      text: "Which?",
      options: ["A", "B"],
    });
    expect(bodies[1]).toMatchObject({ kind: "error" });
  });

  test("a lost response is retried with the same delivery id", async () => {
    config.agents.callbackTimeoutMs = 100;
    config.agents.outboxRetryBaseMs = 0;
    answers.push("slow");
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Again." } }] },
    ]);
    await startConversation(stage, "Call me.", { callbackUrl: hookUrl });
    await runTicks();
    await drainQueue("outbox");
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .orderBy(outboxMessages.id)
      .then((rows) => rows.slice(-1));
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();

    const due = await runAction<{ attempted: number }>("outbox:deliver-due");
    expect(due.attempted).toBe(1);
    expect(received).toHaveLength(2);
    expect(received[0].delivery).toBe(received[1].delivery);
    expect(received[0].body).toBe(received[1].body);
    const [after] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, row.id));
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("a receiver's 4xx is undeliverable; past the retry window, a 5xx is too", async () => {
    answers.push(410);
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Gone." } }] },
    ]);
    await startConversation(stage, "Call me.", { callbackUrl: hookUrl });
    await runTicks();
    await drainQueue("outbox");
    const [gone] = await api.db.db
      .select()
      .from(outboxMessages)
      .orderBy(outboxMessages.id)
      .then((rows) => rows.slice(-1));
    expect(gone.status).toBe("undeliverable");

    config.agents.outboxRetryWindowMs = 0;
    answers.push(503);
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Late." } }] },
    ]);
    await startConversation(stage, "Call me.", { callbackUrl: hookUrl });
    await runTicks();
    await drainQueue("outbox");
    const [late] = await api.db.db
      .select()
      .from(outboxMessages)
      .orderBy(outboxMessages.id)
      .then((rows) => rows.slice(-1));
    expect(late.status).toBe("undeliverable");
  });

  test("a private address is refused at creation, and at delivery", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Never." } }] },
    ]);
    const res = await startConversation(stage, "Call me.", {
      callbackUrl: hookUrl,
    });
    await runTicks();
    config.network.allowPrivateHosts = false;
    const refused = await startConversation(stage, "Call me.", {
      callbackUrl: "https://10.0.0.1/hook",
    });
    expect(refused.status).toBe(406);
    expect(refused.body.error?.key).toBe("callbackUrl");

    // The row written while the guard was lifted is never sent once it is on.
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, res.body.conversation.id));
    expect(await deliverOutboxMessage(row.id)).toBe("undeliverable");
    expect(received).toHaveLength(0);
  });
});
