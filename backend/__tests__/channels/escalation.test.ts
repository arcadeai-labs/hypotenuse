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
import { auditLogs } from "../../schema/audit_logs";
import { bots } from "../../schema/bots";
import { helpRequests } from "../../schema/help_requests";
import { notifications } from "../../schema/notifications";
import { clearLoopQueues, conversationRow, runTicks } from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  conversationFor,
  resetChannels,
  settle,
} from "./harness";

/**
 * Escalation to people: `escalate_to_human` notifies the bot's help tag
 * holders who can read it (else admins), tells the channel only that a
 * person was asked, and the answer — or the expiry — resumes the
 * conversation. A conversation may ask at most five times.
 */
let stage: ChannelStage;
let platformDefaults: typeof config.platforms;

beforeAll(async () => {
  stage = await buildChannelStage();
  platformDefaults = { ...config.platforms };
}, HOOK_TIMEOUT);

afterEach(async () => {
  Object.assign(config.platforms, platformDefaults);
  await clearLoopQueues();
  await resetChannels();
  await api.db.db.delete(notifications);
  await api.db.db
    .update(bots)
    .set({ helpNotifyTag: null, accessRead: [] })
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

const SECRET_QUESTION = "May I refund order 1234 without a receipt?";

/** The bot escalates, blocking. */
const escalate = (extra: Record<string, unknown> = {}) => ({
  toolCalls: [
    {
      name: "escalate_to_human",
      input: {
        question: SECRET_QUESTION,
        context: "The customer insists.",
        ...extra,
      },
    },
  ],
});

/**
 * Start a thread in #support and run it to its escalation.
 * @param thread - The thread.
 * @returns The conversation id.
 */
async function escalated(thread = "T-help"): Promise<number> {
  await stage.platform.send({
    channel: { id: "C-support", name: "support" },
    conversation: thread,
    text: "Refund me!",
    mentions: true,
  });
  await settle();
  return (await conversationFor(thread)).id;
}

/**
 * The recipients of the newest help notification.
 * @returns User ids.
 */
async function recipients(): Promise<number[]> {
  const rows = await api.db.db
    .select()
    .from(notifications)
    .where(eq(notifications.template, "help-requested"));
  return [...new Set(rows.map((r) => r.userId))].sort();
}

describe("escalate_to_human", () => {
  test("recipients: the help tag's holders who can read the bot, else the admins", async () => {
    await api.db.db
      .update(bots)
      .set({ helpNotifyTag: "operators" })
      .where(eq(bots.id, stage.botId));
    stage.models.play([escalate()]);
    await escalated("T-r1");
    expect(await recipients()).toEqual([stage.u.mario.userId]);

    await api.db.db.delete(notifications);
    // Mario holds the tag but may no longer read the bot: the admins hear instead.
    await api.db.db
      .update(bots)
      .set({ accessRead: ["viewers"] })
      .where(eq(bots.id, stage.botId));
    stage.models.play([escalate()]);
    await escalated("T-r2");
    const heard = await recipients();
    expect(heard).toContain(stage.u.peach.userId);
    expect(heard).not.toContain(stage.u.mario.userId);
  });

  test("the channel hears only that a person was asked; the answer resumes the conversation", async () => {
    stage.models.play([
      escalate(),
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Refund approved." } },
        ],
        expect: { lastMessageIncludes: "Answer from Peach: Yes, refund it." },
      },
    ]);
    const id = await escalated();
    const row = await conversationRow(id);
    expect(row).toMatchObject({ state: "waiting" });
    expect(row.waitingOn?.kind).toBe("answer");
    const said = JSON.stringify(stage.platform.deliveries);
    expect(said).toContain("I've asked a person on the team.");
    expect(said).not.toContain(SECRET_QUESTION);

    const [request] = await api.db.db.select().from(helpRequests);
    expect(request).toMatchObject({
      status: "pending",
      blocking: true,
      urgency: "normal",
    });
    const listed = await call<{
      helpRequests: { id: number; canAnswer: boolean }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/help?status=pending`,
    );
    expect(listed.body.helpRequests).toMatchObject([
      { id: request.id, canAnswer: true },
    ]);
    // Toad may read the bot but is neither its writer nor an admin.
    await api.db.db
      .update(bots)
      .set({ accessWrite: ["operators"] })
      .where(eq(bots.id, stage.botId));
    const refused = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${stage.u.projectId}/help/${request.id}`,
      { answer: "No." },
    );
    expect(refused.status).not.toBe(200);
    await api.db.db
      .update(bots)
      .set({ accessWrite: [] })
      .where(eq(bots.id, stage.botId));

    const answered = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/help/${request.id}`,
      { answer: "Yes, refund it." },
    );
    expect(answered.status).toBe(200);
    await settle();
    expect((await conversationRow(id)).state).toBe("hibernating");
    expect(stage.platform.deliveries.at(-1)).toMatchObject({
      text: "Refund approved.",
    });
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "help:answer"));
    expect(audit.userId).toBe(stage.u.peach.userId);
    expect(JSON.stringify(audit)).not.toContain("Yes, refund it.");
  });

  test("a non-blocking request lets the turn go on", async () => {
    stage.models.play([
      escalate({ blocking: false }),
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "I asked; meanwhile…" } },
        ],
      },
    ]);
    const id = await escalated("T-nb");
    expect((await conversationRow(id)).state).toBe("hibernating");
    const [request] = await api.db.db.select().from(helpRequests);
    expect(request.blocking).toBe(false);
  });

  test("expiry: nobody answers in time, and the bot is told so", async () => {
    stage.models.play([
      escalate({ timeoutSeconds: 60 }),
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Nobody knew." } },
        ],
        expect: { lastMessageIncludes: "Nobody on the team answered" },
      },
    ]);
    const id = await escalated("T-exp");
    await api.db.db
      .update(helpRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await runAction<{ expired: number }>("help:expire");
    expect(expired.expired).toBe(1);
    await runTicks();
    const [request] = await api.db.db.select().from(helpRequests);
    expect(request.status).toBe("expired");
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("the cap: past five requests the bot is told to stop asking", async () => {
    config.platforms.helpCapPerConversation = 1;
    stage.models.play([
      escalate({ blocking: false }),
      escalate({ blocking: false }),
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "I cannot ask again." } },
        ],
        expect: { lastMessageIncludes: "help_cap_reached" },
      },
    ]);
    await escalated("T-cap");
    expect(await api.db.db.select().from(helpRequests)).toHaveLength(1);
  });
});
