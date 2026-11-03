import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { api, config } from "keryx";
import { latestSlot } from "../../ops/ScheduleOps";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";
import { scheduleRuns } from "../../schema/schedule_runs";
import { schedules } from "../../schema/schedules";
import { clearLoopQueues, conversationRow, drainQueue } from "../agent/harness";
import { settle } from "../channels/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildSlackStage,
  conversationForThread,
  resetSlack,
  type SlackStage,
} from "./harness";

/**
 * A schedule whose target is a Slack channel: each slot is a new
 * conversation whose first message posts at the top of the channel and opens
 * its thread, which then works like any other.
 */
let stage: SlackStage;
const CHANNEL = "C0GENERAL";

beforeAll(async () => {
  stage = await buildSlackStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await api.db.db.delete(schedules);
  await resetSlack();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.slack.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.slack.reset();
});

afterAll(async () => {
  config.platforms.slack.apiUrl = stage.apiUrl;
  await stage.slack.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A step for the scripted model. */
const step = (name: string, input: Record<string, unknown>) => ({
  toolCalls: [{ name, input }],
});

/**
 * Bind the bot in the channel the way people do — by mentioning it there —
 * then attach a schedule targeting the channel, its newest slot due.
 * @returns The schedule's id.
 */
async function channelSchedule(): Promise<number> {
  stage.models.play([step("reply_and_wait", { text: "Hello." })]);
  await stage.slack.say({ channel: CHANNEL, text: "Hi", mention: true });
  await settle();
  const [channel] = await api.db.db
    .select()
    .from(channels)
    .where(like(channels.externalId, `%/${CHANNEL}`));
  const res = await call<{ schedule: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/schedule`,
    {
      name: "Monday summary",
      targetType: "channel",
      channelId: channel.id,
      cron: "*/5 * * * *",
      instruction: "Summarize the open issues.",
    },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await api.db.db
    .update(schedules)
    .set({ nextRunAt: latestSlot("*/5 * * * *", "UTC", new Date()) as Date })
    .where(eq(schedules.id, res.body.schedule.id));
  stage.slack.reset();
  return res.body.schedule.id;
}

/** The bot's top-level messages in the channel. */
function topLevel() {
  return [...stage.slack.messages.values()].filter(
    (m) =>
      m.channel === CHANNEL &&
      m.threadTs === null &&
      m.user === stage.slack.botUserId,
  );
}

describe("a Slack channel target", () => {
  // Coverage: `slack.out.scheduled-thread`.
  test("the slot's message opens a thread at the top of the channel, and a reply in it continues the conversation", async () => {
    const id = await channelSchedule();
    stage.models.play([
      step("memory_search", { query: "open issues" }),
      step("complete", { summary: "Three issues are open." }),
    ]);
    await runAction("schedules:due");
    await drainQueue("agents");
    await settle();
    const posted = topLevel();
    expect(posted.map((m) => m.text)).toEqual(["Three issues are open."]);
    // No status line was set: there was no thread for it yet.
    expect(stage.slack.statuses).toEqual([]);
    const [run] = await api.db.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, id));
    expect(run.status).toBe("posted");
    const conversation = await conversationRow(run.conversationId as number);
    expect(conversation.externalConversationKey).toBe(posted[0].ts);

    stage.models.play([
      step("reply_and_wait", { text: "Two of them are P1." }),
    ]);
    await stage.slack.say({
      channel: CHANNEL,
      text: "Which are urgent?",
      threadTs: posted[0].ts,
    });
    await settle();
    expect((await conversationForThread(posted[0].ts)).id).toBe(
      conversation.id,
    );
    expect(
      stage.slack.botMessages(CHANNEL, posted[0].ts).map((m) => m.text),
    ).toEqual(["Three issues are open.", "Two of them are P1."]);
  });

  // Coverage: `slack.out.scheduled-thread`.
  test("a silent slot posts nothing to Slack and records silent", async () => {
    const id = await channelSchedule();
    stage.models.play([step("complete", { silent: true })]);
    await runAction("schedules:due");
    await drainQueue("agents");
    await settle();
    expect(stage.slack.calls("chat.postMessage")).toHaveLength(0);
    expect(topLevel()).toHaveLength(0);
    const [run] = await api.db.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, id));
    expect(run.status).toBe("silent");
  });

  test("a removed binding skips the slot, and nothing reaches Slack", async () => {
    const id = await channelSchedule();
    await api.db.db
      .delete(channelBindings)
      .where(and(eq(channelBindings.botId, stage.botId)));
    await runAction("schedules:due");
    const ran = await drainQueue("agents");
    expect(ran).not.toContain("agent:tick");
    const [run] = await api.db.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, id));
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe("The bot is no longer bound to this channel.");
    expect(stage.slack.calls("chat.postMessage")).toHaveLength(0);
  });
});
