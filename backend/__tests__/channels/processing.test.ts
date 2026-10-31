import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { botInstallations } from "../../schema/bot_installations";
import { bots } from "../../schema/bots";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";
import { conversationInbox } from "../../schema/conversation_inbox";
import { participants } from "../../schema/participants";
import { clearLoopQueues, conversationRow, shape } from "../agent/harness";
import { HOOK_TIMEOUT } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  conversationFor,
  lastEvent,
  outboxOf,
  reply,
  resetChannels,
  settle,
} from "./harness";

/**
 * Processing a trigger event: one test per row of the rules table in
 * `TriggerEventOps`, each driven by the webhook platform's fake posting a
 * signed delivery to a booted server.
 */
let stage: ChannelStage;

beforeAll(async () => {
  stage = await buildChannelStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetChannels();
  await api.db.db
    .update(bots)
    .set({
      autoBind: { public: true, private: false, dm: false },
      participantRateLimit: 20,
      channelRateLimit: 60,
    })
    .where(eq(bots.id, stage.botId));
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  stage.platform.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A message that mentions the bot in #general. */
const hello = {
  channel: { id: "C-general", name: "general" },
  conversation: "T-1",
  text: "Hello, Toadsworth?",
  mentions: true,
};

// Coverage: `webhook.in.message`, `webhook.in.interaction.answer`, `webhook.in.signal`, `webhook.in.lifecycle`.
describe("the processing rules", () => {
  test("row 1: our own bot, another bot, and an edit are ignored as loops", async () => {
    for (const draft of [
      { ...hello, sender: { id: "B-toadsworth", name: "Toadsworth" } },
      { ...hello, sender: { id: "B-other", name: "Other", isBot: true } },
      { ...hello, edited: true },
    ]) {
      expect((await stage.platform.send(draft)).status).toBe(200);
      await settle();
      expect(await lastEvent()).toMatchObject({
        status: "ignored",
        outcome: "loop",
      });
    }
    expect(await conversationFor("T-1")).toBeUndefined();
    expect(stage.models.completions).toHaveLength(0);
  });

  test("row 2: an uninstall marks the installation; an archive marks the channel", async () => {
    await stage.platform.send({
      ...hello,
      type: "lifecycle",
      lifecycle: "channel_archived",
    });
    await settle();
    expect(await lastEvent()).toMatchObject({
      status: "processed",
      outcome: "lifecycle",
    });
    const [ch] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.externalId, "acme/C-general"));
    expect(ch.archived).toBe(true);
    await api.db.db.update(channels).set({ archived: false });

    await stage.platform.send({
      ...hello,
      type: "lifecycle",
      lifecycle: "uninstall",
    });
    await settle();
    const [inst] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.installationId));
    expect(inst.status).toBe("uninstalled");
    // An uninstalled installation's URL is the 404.
    expect((await stage.platform.send(hello)).status).toBe(404);
  });

  test("row 3: an externally shared channel is ignored unless the binding allows it", async () => {
    await stage.platform.send({
      ...hello,
      channel: { id: "C-connect", name: "connect", shared: true },
    });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "shared-channel" });
    expect(await api.db.db.select().from(channelBindings)).toHaveLength(0);
  });

  test("row 4: an unbound private channel is ignored, and upserted for a person to bind", async () => {
    await stage.platform.send({
      ...hello,
      channel: { id: "G-secret", name: "secret", private: true },
    });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "unbound" });
    const [ch] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.externalId, "acme/G-secret"));
    expect(ch).toMatchObject({ isPrivate: true, type: "webhook" });
    expect(await api.db.db.select().from(channelBindings)).toHaveLength(0);
  });

  test("row 5: a public channel binds itself by the bot's autoBind, recorded on the event", async () => {
    stage.models.play([reply("Hello.")]);
    await stage.platform.send(hello);
    await settle();
    const event = await lastEvent();
    expect(event).toMatchObject({ status: "processed", outcome: "message" });
    expect(event.detail).toMatchObject({ autoBound: true });
    const [binding] = await api.db.db.select().from(channelBindings);
    expect(binding).toMatchObject({
      autoBound: true,
      mode: "mentions",
      enabled: true,
    });
  });

  test("row 6: a disabled binding is ignored", async () => {
    stage.models.play([reply("Hello.")]);
    await stage.platform.send(hello);
    await settle();
    await api.db.db.update(channelBindings).set({ enabled: false });
    await stage.platform.send({ ...hello, text: "Again?" });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "disabled" });
  });

  test("row 7: an unaddressed message in a mentions channel is ignored, unless the bot is in the thread", async () => {
    await stage.platform.send({ ...hello, mentions: false });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "not-addressed" });

    stage.models.play([reply("Hello."), reply("Yes?")]);
    await stage.platform.send(hello);
    await settle();
    await stage.platform.send({ ...hello, mentions: false, text: "And?" });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "message" });
    expect(stage.models.completions).toHaveLength(2);
  });

  test("row 8: a stop signal cancels the conversation", async () => {
    stage.models.play([
      {
        toolCalls: [{ name: "ask_question", input: { question: "Which?" } }],
      },
    ]);
    await stage.platform.send(hello);
    await settle();
    const conversation = await conversationFor("T-1");
    expect(conversation.state).toBe("waiting");
    await stage.platform.send({ ...hello, type: "signal", signal: "stop" });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "signal" });
    const row = await conversationRow(conversation.id);
    expect(row).toMatchObject({ state: "ended", outcome: "cancelled" });
  });

  test("row 9: an interaction answers the question it targets; a stale one is ignored", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: { question: "Which?", options: ["Cake", "Pie"] },
          },
        ],
      },
      { ...reply("Pie it is."), expect: { lastMessageIncludes: "Pie" } },
    ]);
    await stage.platform.send(hello);
    await settle();
    const conversation = await conversationFor("T-1");
    const question = stage.platform.deliveries.find(
      (d) => d.kind === "question",
    );
    expect(question).toMatchObject({ options: ["Cake", "Pie"] });
    await stage.platform.send({
      ...hello,
      type: "interaction",
      interaction: { kind: "answer", targetId: "999999", value: "Cake" },
    });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "stale-interaction" });
    await stage.platform.send({
      ...hello,
      type: "interaction",
      interaction: {
        kind: "answer",
        targetId: String(question?.questionEntryId),
        value: "Pie",
      },
    });
    await settle();
    expect(await lastEvent()).toMatchObject({ outcome: "interaction" });
    expect((await conversationRow(conversation.id)).state).toBe("hibernating");
    const [inbox] = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, conversation.id))
      .orderBy(conversationInbox.id)
      .then((r) => r.slice(-1));
    expect(inbox).toMatchObject({ text: "Pie", source: "participant" });
    expect(inbox.metadata).toMatchObject({ source: "interaction" });
  });

  test("row 10: past the participant's limit a message is ignored as rate-limited", async () => {
    await api.db.db
      .update(bots)
      .set({ participantRateLimit: 1 })
      .where(eq(bots.id, stage.botId));
    stage.models.play([reply("Hello.")]);
    await stage.platform.send(hello);
    await settle();
    await stage.platform.send({ ...hello, text: "Again!" });
    await settle();
    const event = await lastEvent();
    expect(event).toMatchObject({ status: "ignored", outcome: "rate-limited" });
    expect(event.detail).toMatchObject({ scope: "participant" });
  });

  test("row 11: a message reaches the inbox, wakes the bot, acknowledges, and the reply is delivered", async () => {
    stage.models.play([reply("Good day, Peach.")]);
    await stage.platform.send(hello);
    await settle();
    const event = await lastEvent();
    expect(event).toMatchObject({ status: "processed", outcome: "message" });
    const conversation = await conversationFor("T-1");
    expect(conversation.botId).toBe(stage.botId);
    expect(await shape(conversation.id)).toContain("message:user");
    const [person] = await api.db.db.select().from(participants);
    expect(person).toMatchObject({
      externalUserId: "U-peach",
      displayName: "Peach",
      externalWorkspaceId: "acme",
    });
    const rows = await outboxOf(conversation.id);
    expect(rows[0]).toMatchObject({ kind: "status", priority: "ack" });
    const kinds = stage.platform.deliveries.map((d) => d.kind);
    expect(kinds[kinds.length - 1]).toBe("message");
    expect(stage.platform.deliveries.at(-1)).toMatchObject({
      text: "Good day, Peach.",
      channel: "C-general",
      conversation: "T-1",
    });
    expect(stage.platform.requests.every((r) => r.valid)).toBe(true);
  });
});
