import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import { bots } from "../../schema/bots";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";
import { clearLoopQueues } from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildChannelStage,
  type ChannelStage,
  editBinding,
  lastEvent,
  resetChannels,
  settle,
} from "./harness";

/**
 * Bindings: the audience decision. `autoBind` by kind of channel, a private
 * channel bound only by a person who says what it means, a shared channel
 * refused unless allowed, and an audit row for every change.
 */
let stage: ChannelStage;

beforeAll(async () => {
  stage = await buildChannelStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetChannels();
  await api.db.db.delete(channels);
  stage.models.reset();
  stage.platform.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The channel a delivery upserted.
 * @param id - The platform's channel id.
 * @returns The row.
 */
async function channelOf(id: string) {
  const [row] = await api.db.db
    .select()
    .from(channels)
    .where(eq(channels.externalId, `acme/${id}`));
  return row;
}

/**
 * Bind over HTTP.
 * @param body - The inputs.
 * @param user - Who.
 * @returns The status and body.
 */
function bind(body: Record<string, unknown>, user = stage.u.peach) {
  return call<{ binding: { id: number } }>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/channel-binding`,
    { botId: stage.botId, ...body },
  );
}

describe("autoBind", () => {
  test("defaults: public binds itself, private and DM do not", async () => {
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, stage.botId));
    expect(bot.autoBind).toEqual({ public: true, private: false, dm: false });
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    for (const [channel, outcome] of [
      [{ id: "C-pub", name: "pub" }, "message"],
      [{ id: "G-priv", name: "priv", private: true }, "unbound"],
      [{ id: "D-dm", name: "dm", dm: true }, "unbound"],
    ] as const) {
      await stage.platform.send({
        channel,
        conversation: `T-${channel.id}`,
        text: "Hi",
        mentions: true,
      });
      await settle();
      expect((await lastEvent()).outcome).toBe(outcome);
    }
  });

  test("a bot's autoBind is edited through bot:edit, audited", async () => {
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { autoBind: { public: false, private: false, dm: true } },
    );
    expect(res.status).toBe(200);
    await stage.platform.send({
      channel: { id: "D-2", dm: true },
      conversation: "T-d",
      text: "Hi",
    });
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    await settle();
    expect((await lastEvent()).outcome).toBe("message");
    const [binding] = await api.db.db.select().from(channelBindings);
    expect(binding).toMatchObject({ mode: "dm", autoBound: true });
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { autoBind: { public: true, private: false, dm: false } },
    );
  });
});

describe("a person binds", () => {
  test("a private channel needs confirmAudience, said in so many words; then it listens", async () => {
    await stage.platform.send({
      channel: { id: "G-ops", name: "ops", private: true },
      conversation: "T-o",
      text: "Hi",
      mentions: true,
    });
    await settle();
    const channel = await channelOf("G-ops");
    const refused = await bind({ channelId: channel.id });
    expect(refused.status).toBe(406);
    expect(refused.body.error?.key).toBe("confirmAudience");
    expect(String(refused.body.error?.message)).toContain(
      "everyone who can read",
    );
    const bound = await bind({ channelId: channel.id, confirmAudience: true });
    expect(bound.status).toBe(200);
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    await stage.platform.send({
      channel: { id: "G-ops", name: "ops", private: true },
      conversation: "T-o",
      text: "Now?",
      mentions: true,
    });
    await settle();
    expect((await lastEvent()).outcome).toBe("message");
  });

  test("a shared channel is refused unless allowShared", async () => {
    await stage.platform.send({
      channel: { id: "C-ext", shared: true },
      conversation: "T-x",
      text: "Hi",
      mentions: true,
    });
    await settle();
    const channel = await channelOf("C-ext");
    const refused = await bind({ channelId: channel.id });
    expect(refused.body.error?.key).toBe("allowShared");
    const bound = await bind({ channelId: channel.id, allowShared: true });
    expect(bound.status).toBe(200);
  });

  test("only a bot's writers may bind it", async () => {
    await stage.platform.send({
      channel: { id: "C-w" },
      conversation: "T-w",
      text: "Hi",
    });
    await settle();
    const channel = await channelOf("C-w");
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: ["operators"] },
    );
    const refused = await bind({ channelId: channel.id }, stage.u.luigi);
    expect(refused.status).not.toBe(200);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: [] },
    );
  });

  test("create, edit (the approval policy), and delete are each audited", async () => {
    await stage.platform.send({
      channel: { id: "G-a", private: true },
      conversation: "T-a",
      text: "Hi",
    });
    await settle();
    const channel = await channelOf("G-a");
    const bound = await bind({
      channelId: channel.id,
      confirmAudience: true,
    });
    const id = bound.body.binding.id;
    const listedOnCreate = await bind({
      channelId: channel.id,
      approvalPolicy: "listed",
      confirmAudience: true,
    });
    expect(listedOnCreate.body.error?.key).toBe("approverExternalIds");
    const listedEmpty = await editBinding(stage, id, {
      approvalPolicy: "listed",
    });
    expect(listedEmpty.body.error?.key).toBe("approverExternalIds");
    expect(
      (
        await editBinding(stage, id, {
          approvalPolicy: "participants",
          mode: "all",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.peach,
          "DELETE",
          `/project/${stage.u.projectId}/channel-binding/${id}`,
        )
      ).status,
    ).toBe(200);
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "channel-binding")))
      .orderBy(auditLogs.id);
    expect(rows.slice(-3).map((r) => r.action)).toEqual([
      "channel-binding:create",
      "channel-binding:edit",
      "channel-binding:delete",
    ]);
    expect(rows.at(-2)?.after).toMatchObject({
      approvalPolicy: "participants",
      mode: "all",
    });
  });
});
