import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import type { ActionResponse } from "keryx";
import { api } from "keryx";
import type { ConversationLive } from "../../actions/conversation/conversation-live";
import type { ConversationView } from "../../actions/conversation/conversation-view";
import { CONVERSATION_FRAME } from "../../ops/ConversationOps";
import { outboxMessages } from "../../schema/outbox_messages";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  drainQueue,
  runTicks,
  sendMessage,
  startConversation,
  startTick,
  until,
} from "../agent/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import { type ConformanceDriver, conformance } from "./conformance";

/**
 * The `web` platform, the dashboard chat: its channels, its live read of the
 * streamed text, the caller's standing, and the conformance cases that need
 * no wire, with the dashboard's own reads as the platform.
 */
let stage: AgentStage;
let fixture: McpFixture;
const threads = new Map<string, number>();

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
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
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  fixture.reset();
});

afterAll(async () => {
  await fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Read a conversation's live surface over HTTP.
 * @param id - The conversation.
 * @returns The live body.
 */
async function live(id: number) {
  const res = await call<ActionResponse<ConversationLive>>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/conversation/${id}/live`,
  );
  expect(res.status).toBe(200);
  return res.body.live;
}

/**
 * Read a conversation's standing over HTTP.
 * @param id - The conversation.
 * @param user - Who asks.
 * @returns The standing.
 */
async function standing(id: number, user = stage.u.peach) {
  const res = await call<ActionResponse<ConversationView>>(
    stage.u.url,
    user,
    "GET",
    `/project/${stage.u.projectId}/conversation/${id}`,
  );
  return res.body.standing;
}

describe("web channels", () => {
  test("channelType web uses the bot's dashboard channel; fresh mints a new one each time", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "1" } }] },
    ]);
    const a = await startConversation(stage, "Hi", { channelType: "web" });
    const b = await startConversation(stage, "Hi", { channelType: "web" });
    expect(a.status).toBe(200);
    expect(a.body.channel).toMatchObject({ type: "web", name: "dashboard" });
    expect(b.body.channel.id).toBe(a.body.channel.id);
    const f1 = await startConversation(stage, "Hi", {
      channelType: "web",
      fresh: true,
    });
    const f2 = await startConversation(stage, "Hi", {
      channelType: "web",
      fresh: true,
    });
    expect(f1.body.channel.name).toMatch(/^scratch-[0-9a-f]{8}$/);
    expect(f2.body.channel.id).not.toBe(f1.body.channel.id);
    const plain = await startConversation(stage, "Hi");
    expect(plain.body.channel).toMatchObject({ type: "api", name: "default" });
  });

  test("a callbackUrl is refused for a web chat, naming the field; fresh needs web", async () => {
    const res = await startConversation(stage, "Hi", {
      channelType: "web",
      callbackUrl: "https://example.com/hook",
    });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("callbackUrl");
    const fresh = await startConversation(stage, "Hi", { fresh: true });
    expect(fresh.body.error?.key).toBe("fresh");
  });

  test("a fact learned in a fresh channel is not found from the dashboard channel", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "memory_write",
            input: {
              path: "dessert.md",
              scope: "channel",
              content: "Peach likes pie.",
              changeNote: "Learned it.",
            },
          },
        ],
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Noted." } }] },
      {
        toolCalls: [{ name: "memory_list", input: { scope: "channel" } }],
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Nothing." } }],
        expect: { noMessageIncludes: "dessert.md" },
      },
    ]);
    await startConversation(stage, "I like pie.", {
      channelType: "web",
      fresh: true,
    });
    await runTicks();
    await startConversation(stage, "What do I like?", { channelType: "web" });
    await runTicks();
  });

  test("streamed text grows in conversation:live, and the committed reply replaces it", async () => {
    const text = "The castle has many rooms and every one of them is tidy.";
    stage.models.play([
      {
        text,
        textPieces: 12,
        streamDelayMs: 60,
        toolCalls: [{ name: "reply_and_wait", input: { text: "Tidy." } }],
      },
    ]);
    const res = await startConversation(stage, "Describe it.", {
      channelType: "web",
    });
    const id = res.body.conversation.id;
    const running = startTick(id);
    const seen: string[] = [];
    await until(async () => {
      const l = await live(id);
      if (l.stream?.text && seen.at(-1) !== l.stream.text)
        seen.push(l.stream.text);
      return seen.length >= 2;
    }, 10_000);
    await running;
    expect(text.startsWith(seen[0])).toBe(true);
    expect(seen[1].length).toBeGreaterThan(seen[0].length);
    expect(text.startsWith(seen[1])).toBe(true);
    const after = await live(id);
    expect(after).toMatchObject({
      state: "hibernating",
      stream: null,
      status: null,
    });
    // Frames carry nothing: the text lives in Postgres.
    expect(CONVERSATION_FRAME).toEqual({ event: "conversation" });
  });

  test("a dropped stream's partial text is replaced by the retry's", async () => {
    stage.models.play([
      { text: "This answer breaks off", textPieces: 6, dropAfter: 6 },
      {
        text: "This one finishes.",
        toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }],
      },
    ]);
    const res = await startConversation(stage, "Go.", { channelType: "web" });
    await runTicks();
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, res.body.conversation.id))
      .orderBy(outboxMessages.id);
    const streams = rows
      .filter((r) => r.kind === "stream")
      .map((r) => String((r.payload as { text: string }).text));
    const reset = streams.indexOf("");
    expect(reset).toBeGreaterThan(0);
    expect(
      streams
        .slice(0, reset)
        .every((t) => "This answer breaks off".startsWith(t)),
    ).toBe(true);
    expect(streams.at(-1)).toBe("This one finishes.");
  });

  test("standing: canAnswer while asking, canDecideApprovals by write access", async () => {
    stage.models.play([
      { toolCalls: [{ name: "ask_question", input: { question: "Which?" } }] },
    ]);
    const res = await startConversation(stage, "Ask.", { channelType: "web" });
    const id = res.body.conversation.id;
    expect(await standing(id)).toMatchObject({
      canAnswer: false,
      canDecideApprovals: true,
    });
    await runTicks();
    expect(await standing(id)).toMatchObject({ canAnswer: true });
    // Luigi is a plain member: he may talk to the bot but not decide its calls.
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: ["admin"] },
    );
    const luigi = await standing(id, stage.u.luigi);
    expect(luigi).toMatchObject({ canAnswer: true, canDecideApprovals: false });
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: [] },
    );
  });
});

const driver = (): ConformanceDriver => ({
  models: stage.models,
  async say(thread, text) {
    const known = threads.get(thread);
    if (known) {
      await sendMessage(stage, known, text);
      return known;
    }
    const res = await startConversation(stage, text, { channelType: "web" });
    threads.set(thread, res.body.conversation.id);
    return res.body.conversation.id;
  },
  async settle() {
    for (let i = 0; i < 5; i++) {
      if ((await drainQueue("agents", { only: "agent:tick" })).length === 0)
        return;
    }
  },
  async shown(conversationId) {
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, conversationId))
      .orderBy(outboxMessages.id);
    return rows
      .filter((r) => r.status !== "superseded")
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        ...(r.payload as Record<string, unknown>),
      }));
  },
  async statuses(conversationId) {
    const l = await live(conversationId);
    return l.status?.text ? [l.status.text] : [];
  },
  async pressAnswer(conversationId, _questionEntryId, label) {
    const res = await sendMessage(stage, conversationId, label);
    expect(res.status).toBe(200);
  },
  policies: ["card"],
  setPolicy: async () => {},
  async decide(_conversationId, approvalId, approve) {
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approvalId}`,
      { decision: approve ? "approve" : "deny", via: "dashboard" },
    );
    return res.status === 200;
  },
  decideInDashboard: async () => {},
});

describe("the web platform conforms", () => {
  conformance("web", driver);
});

describe("finding a member's chats", () => {
  test("conversation:list filters by channel type and by who started it", async () => {
    stage.models.script("ok");
    const mine = await startConversation(stage, "Mine.", {
      channelType: "web",
    });
    await startConversation(
      stage,
      "Theirs.",
      { channelType: "web" },
      stage.u.mario,
    );
    await startConversation(stage, "Over the API.");
    const res = await call<{
      conversations: { id: number; createdByUserId: number }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/conversations?channelType=web&mine=true&limit=100`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.conversations.map((c) => c.id);
    expect(ids).toContain(mine.body.conversation.id);
    expect(
      res.body.conversations.every(
        (c) => c.createdByUserId === stage.u.peach.userId,
      ),
    ).toBe(true);
  });
});
