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
import { countMessage } from "../../ops/ChannelRateOps";
import { bots } from "../../schema/bots";
import { clearLoopQueues } from "../agent/harness";
import { HOOK_TIMEOUT } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  lastEvent,
  resetChannels,
  settle,
} from "./harness";

/**
 * Rate limits: identity is no defense when the platform's permission is the
 * only gate, so each bot counts messages per participant and per channel.
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
    .set({ participantRateLimit: 20, channelRateLimit: 60 })
    .where(eq(bots.id, stage.botId));
  stage.models.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("rate limits", () => {
  test("per participant: past the limit a sender is ignored, others are not", async () => {
    await api.db.db
      .update(bots)
      .set({ participantRateLimit: 2 })
      .where(eq(bots.id, stage.botId));
    stage.models.script("ok");
    for (let i = 0; i < 3; i++) {
      await stage.platform.send({
        channel: "C-r",
        conversation: `T-${i}`,
        text: "hi",
        mentions: true,
      });
    }
    await settle(1);
    const event = await lastEvent();
    expect(event).toMatchObject({ outcome: "rate-limited" });
    expect(event.detail).toMatchObject({ scope: "participant" });
    await stage.platform.send({
      channel: "C-r",
      conversation: "T-other",
      text: "hi",
      mentions: true,
      sender: { id: "U-mario", name: "Mario" },
    });
    await settle(1);
    expect((await lastEvent()).outcome).toBe("message");
  });

  test("per channel: many senders together hit the channel's limit", async () => {
    await api.db.db
      .update(bots)
      .set({ channelRateLimit: 2 })
      .where(eq(bots.id, stage.botId));
    stage.models.script("ok");
    for (const who of ["U-a", "U-b", "U-c"]) {
      await stage.platform.send({
        channel: "C-busy",
        conversation: who,
        text: "hi",
        mentions: true,
        sender: { id: who, name: who },
      });
    }
    await settle(1);
    const event = await lastEvent();
    expect(event.detail).toMatchObject({ scope: "channel" });
  });

  test("the sender is owed one notice per window, and none where the platform has no ephemeral messages", async () => {
    const bot = { id: 999_001, participantRateLimit: 1, channelRateLimit: 100 };
    expect(await countMessage(bot, 1, "p")).toEqual({ limited: false });
    expect(await countMessage(bot, 1, "p")).toMatchObject({
      limited: true,
      firstNotice: true,
    });
    expect(await countMessage(bot, 1, "p")).toMatchObject({
      limited: true,
      firstNotice: false,
    });
    await api.db.db
      .update(bots)
      .set({ participantRateLimit: 1 })
      .where(eq(bots.id, stage.botId));
    stage.models.script("ok");
    await stage.platform.send({
      channel: "C-n",
      conversation: "T-n1",
      text: "hi",
      mentions: true,
    });
    await stage.platform.send({
      channel: "C-n",
      conversation: "T-n2",
      text: "hi",
      mentions: true,
    });
    await settle(1);
    expect((await lastEvent()).detail).toMatchObject({ noticeOwed: false });
  });
});
