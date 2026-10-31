import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { emit, emitOutbound, emitStream } from "../../ops/SurfaceOps";
import { approvals } from "../../schema/approvals";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { conversationInbox } from "../../schema/conversation_inbox";
import { outboxMessages } from "../../schema/outbox_messages";
import {
  clearLoopQueues,
  conversationRow,
  drainQueue,
  startTick,
  untilRequests,
} from "../agent/harness";
import { lastEvent, settle } from "../channels/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildSlackStage,
  conversationForThread,
  resetSlack,
  type SlackStage,
} from "./harness";

/**
 * A bot in Slack threads, end to end through the fake: what a person in the
 * channel sees for a mention, a stream, a plan, a question, an approval; and
 * what the bot refuses to hear or say.
 */
let stage: SlackStage;
let fixture: McpFixture;
const CHANNEL = "C0GENERAL";

beforeAll(async () => {
  stage = await buildSlackStage();
  fixture = startMcpFixture({});
  const server = await call<{ mcpServer: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/mcp-server`,
    { name: "mail", url: fixture.url, authMode: "none" },
  );
  await call(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/mcp-server`,
    { mcpServerId: server.body.mcpServer.id },
  );
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetSlack();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.slack.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.slack.reset();
  fixture.reset();
});

afterAll(async () => {
  config.platforms.slack.apiUrl = stage.apiUrl;
  await fixture.stop();
  await stage.slack.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A reply step for the scripted model. */
const reply = (text: string) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
});

/**
 * Deliver a conversation's outbox now, as the accelerant after a commit would.
 * @param conversationId - The conversation.
 */
async function deliverNow(conversationId: number) {
  await api.actions.enqueue("outbox:deliver", { conversationId }, "outbox");
  await drainQueue("outbox");
}

/** The bot's messages in a thread, as text. */
function botTexts(threadTs: string): string[] {
  return stage.slack.botMessages(CHANNEL, threadTs).map((m) => m.text);
}

describe("a thread", () => {
  // Coverage: `slack.in.app-mention`, `slack.in.dedupe`, `slack.out.status`, `slack.out.message`.
  test("a mention: the status, the answer in its thread — and one inbox row for two events", async () => {
    stage.models.play([
      { toolCalls: [{ name: "search_history", input: { query: "cake" } }] },
      reply("Cake is in the **kitchen**."),
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Where is the cake?",
      mention: true,
    });
    expect(said.answers.map((a) => a.status)).toEqual([200, 200]);
    await drainQueue("ingress");
    await drainQueue("outbox");
    expect(stage.slack.statuses).toEqual([
      { channel: CHANNEL, threadTs: said.ts, status: "Thinking…" },
    ]);
    await settle();
    const conversation = await conversationForThread(said.ts);
    const inbox = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, conversation.id));
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("Where is the cake?");
    // Progress rows still undelivered when the answer is written are
    // superseded by it: here the tick finished before the outbox ran.
    const bot = stage.slack.botMessages(CHANNEL, said.ts);
    expect(bot.map((m) => m.text)).toEqual(["Cake is in the *kitchen*."]);
    expect(bot.every((m) => m.threadTs === said.ts)).toBe(true);
  });

  // Coverage: `slack.out.plan`.
  test("a turn's plan is one message, edited in place as its steps run", async () => {
    stage.models.play([reply("Ok.")]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Plan?",
      mention: true,
    });
    await settle();
    const conversation = await conversationRow(
      (await conversationForThread(said.ts)).id,
    );
    const plan = (steps: { seq: number; tool: string; state: string }[]) =>
      emit(api.db.db, conversation, { kind: "plan", payload: { steps } });
    await plan([{ seq: 1, tool: "memory_search", state: "running" }]);
    await deliverNow(conversation.id);
    await plan([
      { seq: 1, tool: "memory_search", state: "done" },
      { seq: 2, tool: "mcp_exec", state: "running" },
    ]);
    await deliverNow(conversation.id);
    const plans = stage.slack
      .botMessages(CHANNEL, said.ts)
      .filter((m) => m.text.startsWith("Working:"));
    expect(plans).toHaveLength(1);
    expect(plans[0].edits).toBe(1);
    expect(plans[0].text).toBe("Working: memory_search, mcp_exec");
    const blocks = JSON.stringify(plans[0].blocks);
    expect(blocks).toContain(":white_check_mark: `memory_search`");
    expect(blocks).toContain(":hourglass_flowing_sand: `mcp_exec`");
  });

  // Coverage: `slack.in.thread-reply`.
  test("a reply in the bot's thread continues it without a mention; elsewhere it is not addressed", async () => {
    stage.models.play([reply("Hello."), reply("Still here.")]);
    const first = await stage.slack.say({
      channel: CHANNEL,
      text: "Hi",
      mention: true,
    });
    await settle();
    await stage.slack.say({
      channel: CHANNEL,
      text: "Are you there?",
      threadTs: first.ts,
    });
    await settle();
    expect(botTexts(first.ts)).toEqual(["Hello.", "Still here."]);
    await stage.slack.say({ channel: CHANNEL, text: "Just chatting" });
    await settle();
    expect((await lastEvent()).outcome).toBe("not-addressed");
  });

  // Coverage: `slack.in.dm`.
  test("a DM: each top-level message is its own conversation, answered in its thread", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      {
        autoBind: { public: true, private: false, dm: true },
      },
    );
    stage.models.play([reply("One."), reply("Two.")]);
    const a = await stage.slack.say({
      channel: "D0PEACH",
      text: "first",
      channelType: "im",
    });
    await settle();
    const b = await stage.slack.say({
      channel: "D0PEACH",
      text: "second",
      channelType: "im",
    });
    await settle();
    expect(stage.slack.botMessages("D0PEACH", a.ts).map((m) => m.text)).toEqual(
      ["One."],
    );
    expect(stage.slack.botMessages("D0PEACH", b.ts).map((m) => m.text)).toEqual(
      ["Two."],
    );
    expect((await conversationForThread(a.ts)).id).not.toBe(
      (await conversationForThread(b.ts)).id,
    );
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      {
        autoBind: { public: true, private: false, dm: false },
      },
    );
  });

  // Coverage: `slack.out.stream`.
  test("streamed text: started, appended as a delta, restarted when it does not extend, closed by the answer", async () => {
    stage.models.play([reply("Done.")]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Stream?",
      mention: true,
    });
    await settle();
    const conversation = await conversationRow(
      (await conversationForThread(said.ts)).id,
    );
    for (const text of ["Hel", "Hello, wor", "Rethinking"]) {
      await emitStream(conversation, text);
      await deliverNow(conversation.id);
    }
    expect(stage.slack.calls("chat.startStream")).toHaveLength(2);
    expect(
      stage.slack.calls("chat.appendStream").map((c) => c.args.markdown_text),
    ).toEqual(["lo, wor"]);
    await api.db.db.transaction((tx) =>
      emitOutbound(tx, conversation, conversation.lastSeq, {
        kind: "reply",
        text: "Final.",
      }),
    );
    await deliverNow(conversation.id);
    const bot = stage.slack.botMessages(CHANNEL, said.ts);
    const streams = bot.filter((m) => m.stream);
    expect(streams.map((m) => [m.text, m.stream?.open])).toEqual([
      ["Hello, wor", false],
      ["Rethinking", false],
    ]);
    expect(bot.at(-1)?.text).toBe("Final.");
  });

  // Coverage: `slack.out.stream-age`.
  test("a stream older than Slack's ten minutes is closed and a new one started", async () => {
    stage.models.play([reply("Ok.")]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Long?",
      mention: true,
    });
    await settle();
    const conversation = await conversationRow(
      (await conversationForThread(said.ts)).id,
    );
    stage.slack.tsOffsetSeconds = 11 * 60;
    await emitStream(conversation, "Part one");
    await deliverNow(conversation.id);
    stage.slack.tsOffsetSeconds = 0;
    await emitStream(conversation, "Part one, part two");
    await deliverNow(conversation.id);
    expect(stage.slack.calls("chat.startStream")).toHaveLength(2);
    expect(stage.slack.calls("chat.appendStream")).toHaveLength(0);
    expect(stage.slack.calls("chat.stopStream")).toHaveLength(1);
  });

  // Coverage: `slack.out.mrkdwn`.
  test("an answer is mrkdwn, pings no channel and never the bot, and is truncated with a link past 40,000 characters", async () => {
    stage.models.play([
      reply(
        "<!channel> look: [docs](https://example.com) <@U0TOAD> & <@U0MARIO>",
      ),
      reply("& ".repeat(9_000)),
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Ping?",
      mention: true,
    });
    await settle();
    const [text] = botTexts(said.ts);
    expect(text).toBe(
      "&lt;!channel&gt; look: <https://example.com|docs>  &amp; <@U0MARIO>",
    );
    await stage.slack.say({
      channel: CHANNEL,
      text: "Long?",
      threadTs: said.ts,
    });
    await settle();
    const long = botTexts(said.ts)[1];
    expect(long.length).toBeLessThanOrEqual(40_000);
    expect(long).toContain("/conversations/");
  });
});

describe("questions and approvals", () => {
  // Coverage: `slack.out.question`.
  test("past five options a question is a menu, and picking answers it", async () => {
    const options = ["A", "B", "C", "D", "E", "F"];
    stage.models.play([
      {
        toolCalls: [
          { name: "ask_question", input: { question: "Which?", options } },
        ],
      },
      { ...reply("F it is."), expect: { lastMessageIncludes: "F" } },
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Pick",
      mention: true,
    });
    await settle();
    const [question] = stage.slack.botMessages(CHANNEL, said.ts);
    const select = JSON.stringify(question.blocks);
    expect(select).toContain("static_select");
    const actionId = /"action_id":"(q:\d+:select)"/.exec(select)?.[1] ?? "";
    await stage.slack.press(question.ts, actionId, {
      value: "F",
      select: true,
    });
    await settle();
    expect(botTexts(said.ts).at(-1)).toBe("F it is.");
  });

  // Coverage: `slack.out.approval`.
  test("an approval: a late click is stale; the dashboard policy shows a link and no buttons", async () => {
    stage.models.play([
      { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: { name: "mail/send_email", args: { to: "toad" } },
          },
        ],
      },
      reply("Sent."),
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Email Toad",
      mention: true,
    });
    await drainQueue("ingress");
    await api.db.db
      .update(channelBindings)
      .set({ approvalPolicy: "participants" })
      .where(eq(channelBindings.botId, stage.botId));
    await settle();
    const conversation = await conversationForThread(said.ts);
    const [approval] = await api.db.db
      .select()
      .from(approvals)
      .where(eq(approvals.conversationId, conversation.id));
    const card = stage.slack
      .botMessages(CHANNEL, said.ts)
      .find((m) =>
        JSON.stringify(m.blocks ?? []).includes(`a:${approval.id}:approve`),
      );
    expect(card?.text).toBe("I need approval to run mail/send_email.");
    await stage.slack.press(String(card?.ts), `a:${approval.id}:approve`, {
      value: "approve",
    });
    await settle();
    expect(botTexts(said.ts).at(-1)).toBe("Sent.");
    await stage.slack.press(String(card?.ts), `a:${approval.id}:deny`, {
      value: "deny",
    });
    await drainQueue("ingress");
    expect((await lastEvent()).outcome).toBe("stale-interaction");

    // Under the dashboard policy the card has no buttons, only the link.
    await api.db.db
      .update(channelBindings)
      .set({ approvalPolicy: "dashboard" })
      .where(eq(channelBindings.botId, stage.botId));
    stage.models.play([
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: { name: "mail/send_email", args: { to: "peach" } },
          },
        ],
      },
    ]);
    await stage.slack.say({
      channel: CHANNEL,
      text: "And Peach",
      threadTs: said.ts,
    });
    await settle();
    const last = stage.slack.botMessages(CHANNEL, said.ts).at(-1);
    expect(JSON.stringify(last?.blocks)).not.toContain('"type":"button"');
    expect(JSON.stringify(last?.blocks)).toContain("/approvals/");
  });
});

describe("stop, disengagement, refusals", () => {
  // Coverage: `slack.in.stop`.
  test("agent_session_stopped cancels the conversation and nothing more is said", async () => {
    stage.models.play([
      { toolCalls: [{ name: "ask_question", input: { question: "Sure?" } }] },
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Do it",
      mention: true,
    });
    await settle();
    const before = stage.slack.botMessages(CHANNEL, said.ts).length;
    await stage.slack.deliver({
      type: "agent_session_stopped",
      channel: CHANNEL,
      thread_ts: said.ts,
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("signal");
    expect((await conversationForThread(said.ts)).state).toBe("ended");
    expect(stage.slack.botMessages(CHANNEL, said.ts)).toHaveLength(before);
  });

  // Coverage: `slack.in.channel-left`, `slack.in.member-joined`.
  test("removed from a channel: the binding goes, live conversations end, mentions are ignored; invited again: bound", async () => {
    stage.models.play([
      { toolCalls: [{ name: "ask_question", input: { question: "Hm?" } }] },
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Hi",
      mention: true,
    });
    await settle();
    await stage.slack.deliver({
      type: "channel_left",
      channel: CHANNEL,
      actor_id: "U0PEACH",
    });
    await settle();
    expect((await lastEvent()).detail).toMatchObject({
      lifecycle: "channel_left",
      binding: "deleted",
      cancelled: 1,
    });
    expect((await conversationForThread(said.ts)).state).toBe("ended");
    // Out of the channel, the bot receives nothing from it; inviting it back binds it again.
    await stage.slack.deliver({
      type: "member_joined_channel",
      user: stage.slack.botUserId,
      channel: CHANNEL,
      channel_type: "C",
      team: stage.slack.team.id,
    });
    await settle();
    expect((await lastEvent()).detail).toMatchObject({
      lifecycle: "channel_joined",
      autoBound: true,
    });
    const bindings = await api.db.db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.botId, stage.botId));
    expect(bindings.filter((b) => b.enabled)).toHaveLength(1);
    // Someone else joining is nothing.
    await stage.slack.deliver({
      type: "member_joined_channel",
      user: "U0LUIGI",
      channel: CHANNEL,
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("empty");
  });

  // Coverage: `slack.in.uninstall`.
  test("app_uninstalled and tokens_revoked uninstall silently; the URL becomes the 404", async () => {
    stage.models.play([
      { toolCalls: [{ name: "ask_question", input: { question: "Hm?" } }] },
    ]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Hi",
      mention: true,
    });
    await settle();
    await stage.slack.deliver({ type: "app_uninstalled" });
    await settle();
    const [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.installationId));
    expect(row.status).toBe("uninstalled");
    expect((await conversationForThread(said.ts)).state).toBe("ended");
    const after = await stage.slack.say({
      channel: CHANNEL,
      text: "Anyone?",
      mention: true,
    });
    expect(after.answers.map((a) => a.status)).toEqual([404, 404]);

    await api.db.db.update(botInstallations).set({ status: "active" });
    // A revoked user token is not ours; the bot's is.
    await stage.slack.deliver({
      type: "tokens_revoked",
      tokens: { oauth: ["U0PEACH"], bot: [] },
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("empty");
    await stage.slack.deliver({
      type: "tokens_revoked",
      tokens: { bot: [stage.slack.botUserId] },
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("lifecycle");
  });

  // Coverage: `slack.in.shared-channel`, `slack.in.loop`, `slack.in.edit`.
  test("Slack Connect is refused; the bot never hears itself or a sibling bot; edits are not new messages", async () => {
    await stage.slack.say({
      channel: "C0SHARED",
      text: "Hi",
      mention: true,
      shared: true,
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("shared-channel");
    // Its own message.
    await stage.slack.deliver({
      type: "message",
      channel: CHANNEL,
      channel_type: "channel",
      user: stage.slack.botUserId,
      text: "I said this",
      ts: stage.slack.nextTs(),
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("loop");
    // Another bot of the project mentioning this one.
    await stage.slack.deliver({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0SIBLING",
      bot_id: "B0SIBLING",
      text: `<@${stage.slack.botUserId}> hello`,
      ts: stage.slack.nextTs(),
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("loop");
    await stage.slack.deliver({
      type: "message",
      subtype: "message_changed",
      channel: CHANNEL,
      channel_type: "channel",
      message: { ts: "1700000000.000100", user: "U0PEACH", text: "edited" },
      event_ts: stage.slack.nextTs(),
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("loop");
  });
});

describe("Slack's limits", () => {
  // Coverage: `slack.in.ack`.
  test("ingress answers within three seconds while a tick waits on a slow model", async () => {
    stage.models.play([{ hang: true }, reply("Late.")]);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Slow?",
      mention: true,
    });
    await drainQueue("ingress");
    const conversation = await conversationForThread(said.ts);
    const running = startTick(conversation.id);
    await untilRequests(stage, 1);
    // The model is mid-call: Slack's next delivery is still acknowledged at once.
    const next = await stage.slack.say({
      channel: CHANNEL,
      text: "Hello?",
      threadTs: said.ts,
    });
    for (const a of [...said.answers, ...next.answers]) {
      expect(a.status).toBe(200);
      expect(a.ms).toBeLessThan(3_000);
    }
    stage.models.release();
    await running;
    await settle();
  });

  // Coverage: `slack.out.ratelimited`.
  test("ratelimited with Retry-After reschedules the row; it is sent once the wait is over", async () => {
    stage.models.play([reply("Eventually.")]);
    stage.slack.failNext("chat.postMessage", { ratelimited: 7 });
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Hi",
      mention: true,
    });
    const started = Date.now();
    await settle();
    expect(Date.now() - started).toBeLessThan(5_000);
    const conversation = await conversationForThread(said.ts);
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          eq(outboxMessages.kind, "message"),
        ),
      );
    expect(row.status).toBe("failed");
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(5_000);
    expect(botTexts(said.ts)).toEqual([]);
    await api.db.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(outboxMessages.id, row.id));
    await api.actions.enqueue(
      "outbox:deliver",
      { conversationId: conversation.id },
      "outbox",
    );
    await drainQueue("outbox");
    expect(botTexts(said.ts)).toEqual(["Eventually."]);
  });

  // Coverage: `slack.out.bucket`.
  test("an empty token bucket defers the send without calling Slack", async () => {
    const capacity = config.platforms.slack.bucketCapacity;
    const refill = config.platforms.slack.bucketRefillPerSecond;
    config.platforms.slack.bucketCapacity = 1;
    config.platforms.slack.bucketRefillPerSecond = 0.01;
    try {
      stage.models.play([reply("Later.")]);
      const said = await stage.slack.say({
        channel: CHANNEL,
        text: "Hi",
        mention: true,
      });
      await drainQueue("ingress");
      await drainQueue("outbox");
      expect(stage.slack.calls("assistant.threads.setStatus")).toHaveLength(1);
      await settle();
      // The status took the only token; the answer waits for the bucket.
      expect(stage.slack.calls("chat.postMessage")).toHaveLength(0);
      const conversation = await conversationForThread(said.ts);
      const rows = await api.db.db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.conversationId, conversation.id),
            eq(outboxMessages.kind, "message"),
          ),
        );
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toContain("ratelimited");
    } finally {
      config.platforms.slack.bucketCapacity = capacity;
      config.platforms.slack.bucketRefillPerSecond = refill;
    }
  });

  // Coverage: `slack.out.undeliverable`.
  test("a refusal from Slack makes the row undeliverable, not retried forever", async () => {
    stage.models.play([reply("Nope.")]);
    stage.slack.failNext("chat.postMessage", { error: "not_in_channel" });
    const said = await stage.slack.say({
      channel: CHANNEL,
      text: "Hi",
      mention: true,
    });
    await settle();
    const conversation = await conversationForThread(said.ts);
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          eq(outboxMessages.kind, "message"),
        ),
      );
    expect(row.status).toBe("undeliverable");
    expect(row.error).toContain("not_in_channel");
  });
});
