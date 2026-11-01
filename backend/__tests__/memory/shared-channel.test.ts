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
import { bots } from "../../schema/bots";
import { clearLoopQueues, readEntries } from "../agent/harness";
import {
  buildChannelStage,
  type ChannelStage,
  conversationFor,
  installWebhook,
  reply,
  resetChannels,
  settle,
} from "../channels/harness";
import { WebhookPlatform } from "../fakes/webhook/server";
import { call, HOOK_TIMEOUT, type TestUser } from "../setup";
import { clearMemory } from "./harness";

/**
 * A channel's memory is shared by every bot working there. Toadsworth and
 * Kamek are each their own webhook app in the same workspace; both are
 * mentioned in #general, so both work in the one channel row — and what one
 * remembers there, the other reads. Who may read or change that memory
 * follows the bots working in the channel: any one of them is enough.
 *
 * | Who | Toadsworth (read `operators`, write `operators`) | Kamek (read `viewers`, write `viewers`) | The channel's memory |
 * |---|---|---|---|
 * | Mario (`operators`) | read, write | — | read, write |
 * | Luigi (`viewers`) | — | read, write | read, write |
 * | Toad (no tags) | — | — | 404 |
 * | Peach (owner, admin) | read, write | read, write | read, write |
 */
let stage: ChannelStage;
let kamekPlatform: WebhookPlatform;
let kamekId: number;

beforeAll(async () => {
  stage = await buildChannelStage();
  const created = await call<{ bot: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot`,
    { name: "Kamek", persona: "You are Kamek, a magikoopa." },
  );
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  kamekId = created.body.bot.id;
  kamekPlatform = new WebhookPlatform().start();
  await installWebhook({ ...stage, botId: kamekId }, kamekPlatform);
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetChannels();
  await clearMemory();
  await api.db.db
    .update(bots)
    .set({ accessRead: [], accessWrite: [] })
    .where(eq(bots.projectId, stage.u.projectId));
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  stage.platform.reset();
  kamekPlatform.reset();
});

afterAll(async () => {
  await stage.platform.stop();
  await kamekPlatform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

const general = { id: "C-general", name: "general" };
const FACT = {
  path: "facts/cannon.md",
  scope: "channel",
  content: "The castle cannon fires at noon on Saturdays.",
  changeNote: "Toadsworth was told in #general.",
};

/**
 * The outputs of one tool's results in a conversation, in order.
 * @param conversationId - The conversation.
 * @param toolName - The tool.
 * @returns Each call's stored output.
 */
async function outputsOf(conversationId: number, toolName: string) {
  const { entries } = await readEntries(stage, conversationId);
  return entries
    .filter((e) => e.kind === "tool_result" && e.toolName === toolName)
    .map((e) => (e.content as { output: Record<string, unknown> }).output);
}

/**
 * Toadsworth writes the fact in one #general thread; then Kamek, mentioned
 * in another, reads and searches for it.
 * @returns Both conversations and their channel.
 */
async function rememberedByOneReadByTheOther() {
  stage.models.play([
    { toolCalls: [{ name: "memory_write", input: FACT }] },
    reply("Noted."),
  ]);
  await stage.platform.send({
    channel: general,
    conversation: "T-toadsworth",
    text: "Toadsworth, the cannon fires at noon on Saturdays.",
    mentions: true,
  });
  await settle();
  const toadsworth = await conversationFor("T-toadsworth");

  stage.models.play([
    {
      toolCalls: [
        { name: "memory_read", input: { path: FACT.path, scope: "channel" } },
        { name: "memory_list", input: { scope: "channel" } },
      ],
    },
    reply("Saturdays at noon."),
  ]);
  await kamekPlatform.send({
    channel: general,
    conversation: "T-kamek",
    text: "Kamek, when does the cannon fire?",
    mentions: true,
  });
  await settle();
  const kamek = await conversationFor("T-kamek");
  return { toadsworth, kamek };
}

/**
 * GET the channel's memory list as a user.
 * @param user - Who.
 * @param channelId - The channel.
 * @returns The status and body.
 */
function listAs(user: TestUser, channelId: number) {
  return call<{ documents: { path: string }[] }>(
    stage.u.url,
    user,
    "GET",
    `/project/${stage.u.projectId}/memory?scope=channel&channelId=${channelId}`,
  );
}

describe("two bots in one channel", () => {
  test("share its memory: what one writes, the other reads", async () => {
    const { toadsworth, kamek } = await rememberedByOneReadByTheOther();
    expect(toadsworth.botId).toBe(stage.botId);
    expect(kamek.botId).toBe(kamekId);
    expect(kamek.channelId).toBe(toadsworth.channelId);

    const [written] = await outputsOf(toadsworth.id, "memory_write");
    expect(written).toMatchObject({ path: FACT.path, scope: "channel" });
    const [read] = await outputsOf(kamek.id, "memory_read");
    expect(read).toMatchObject({ scope: "channel", current: true });
    expect(String(read.content)).toContain("noon on Saturdays");
    const [listed] = await outputsOf(kamek.id, "memory_list");
    expect(listed).toMatchObject({
      documents: [{ path: FACT.path, scope: "channel" }],
    });

    // The explorer lists the channel once, with both bots, and one document.
    const channels = await call<{
      channels: {
        id: number;
        documents: number;
        bots: { id: number }[];
        canWrite: boolean;
      }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/memory/channels`,
    );
    expect(channels.status).toBe(200);
    const row = channels.body.channels.find(
      (c) => c.id === toadsworth.channelId,
    );
    expect(row).toMatchObject({ documents: 1, canWrite: true });
    expect(row?.bots.map((b) => b.id).sort()).toEqual(
      [stage.botId, kamekId].sort(),
    );
  });

  test("its memory is read and changed by whoever may read or change any bot working there", async () => {
    const { toadsworth } = await rememberedByOneReadByTheOther();
    const channelId = toadsworth.channelId;
    const { peach, mario, luigi, toad } = stage.u;
    for (const [id, tag] of [
      [stage.botId, "operators"],
      [kamekId, "viewers"],
    ] as const) {
      const edited = await call(
        stage.u.url,
        peach,
        "POST",
        `/project/${stage.u.projectId}/bot/${id}`,
        { accessRead: [tag], accessWrite: [tag] },
      );
      expect(edited.status).toBe(200);
    }

    for (const [user, status] of [
      [peach, 200],
      [mario, 200],
      [luigi, 200],
      [toad, 404],
    ] as const) {
      expect((await listAs(user, channelId)).status, user.email).toBe(status);
      const channels = await call<{ channels: { id: number }[] }>(
        stage.u.url,
        user,
        "GET",
        `/project/${stage.u.projectId}/memory/channels`,
      );
      expect(
        channels.body.channels.some((c) => c.id === channelId),
        `${user.email} sees the channel`,
      ).toBe(status === 200);
    }

    // Luigi changes it through Kamek's access, though he cannot read Toadsworth.
    const write = await call<{ document: { versionId: number } }>(
      stage.u.url,
      luigi,
      "PUT",
      `/project/${stage.u.projectId}/memory/document`,
      {
        scope: "channel",
        channelId,
        path: FACT.path,
        content: "The castle cannon fires at noon on Sundays.",
        changeNote: "It moved",
      },
    );
    expect(write.status).toBe(200);
    expect(
      (
        await call(
          stage.u.url,
          toad,
          "PUT",
          `/project/${stage.u.projectId}/memory/document`,
          { scope: "channel", channelId, path: "facts/x.md", content: "x" },
        )
      ).status,
    ).toBe(404);

    // Once Toadsworth's write list no longer has him, Mario still reads the
    // channel's memory through Toadsworth's read list, but may not change it.
    await call(
      stage.u.url,
      peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: ["admin"] },
    );
    const view = await call<{ standing: { canWrite: boolean } }>(
      stage.u.url,
      mario,
      "GET",
      `/project/${stage.u.projectId}/memory/document?scope=channel&channelId=${channelId}&path=${FACT.path}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.standing.canWrite).toBe(false);
    const refused = await call<{ error: { message: string } }>(
      stage.u.url,
      mario,
      "PUT",
      `/project/${stage.u.projectId}/memory/document`,
      { scope: "channel", channelId, path: FACT.path, content: "Mondays." },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("write access to a bot");
  });
});
