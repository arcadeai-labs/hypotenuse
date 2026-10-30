import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import type { BotRotateCallbackSecret } from "../../actions/bot/bot-rotate-callback-secret";
import type { ConversationList } from "../../actions/conversation/conversation-list";
import { auditLogs } from "../../schema/audit_logs";
import { conversations } from "../../schema/conversations";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  readEntries,
  runTicks,
  sendMessage,
  startConversation,
} from "../agent/harness";
import { call, createTag, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * The API channel's actions over HTTP: create, message, list, view, entries,
 * and cancel; `requestId` dedupe; who may do what (membership plus the bot's
 * read list, and its write list for the callback secret); and refusals that
 * say the same thing for a conversation that is missing and one the caller
 * may not see.
 */
let stage: AgentStage;
let secretBotId: number;
let defaults: typeof config.network;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.network };
  const { u } = stage;
  const staff = await createTag(u.url, u.peach, u.projectId, "castle-staff");
  await call(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/member/${u.mario.userId}/tag/${staff}`,
  );
  const secret = await call<ActionResponse<BotCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/bot`,
    {
      name: "Vault",
      persona: "You guard the vault.",
      accessRead: ["castle-staff"],
      accessWrite: ["castle-staff"],
    },
  );
  if (secret.status !== 200) throw new Error(JSON.stringify(secret.body));
  secretBotId = secret.body.bot.id;
}, HOOK_TIMEOUT);

afterEach(async () => {
  Object.assign(config.network, defaults);
  await clearLoopQueues();
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Start a conversation with a bot as someone.
 * @param user - Who.
 * @param botId - The bot.
 * @param body - The inputs.
 * @returns The status and body.
 */
async function create(
  user: TestUser,
  botId: number,
  body: Record<string, unknown>,
) {
  return call<{
    conversation: { id: number; state: string };
    channel: { name: string; type: string };
    deduped: boolean;
  }>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/bot/${botId}/conversation`,
    body,
  );
}

describe("conversation:create", () => {
  test("creates the conversation in the bot's default API channel, wakes it, and audits the text as a digest", async () => {
    const res = await create(stage.u.mario, stage.botId, {
      text: "Hello, steward.",
    });
    expect(res.status).toBe(200);
    expect(res.body.conversation.state).toBe("working");
    expect(res.body.channel).toMatchObject({ type: "api", name: "default" });
    expect(res.body.deduped).toBe(false);
    expect(await api.resque.queue.length("agents")).toBe(1);

    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "conversation:create"),
          eq(auditLogs.userId, stage.u.mario.userId),
        ),
      );
    expect(row.metadata).toMatchObject({
      text: {
        length: 15,
        sha256: createHash("sha256").update("Hello, steward.").digest("hex"),
      },
    });
    expect(JSON.stringify(row)).not.toContain("Hello, steward.");
    expect(res.body.conversation).toMatchObject({ title: null });
  });

  test("a repeated requestId returns the first conversation", async () => {
    const a = await create(stage.u.mario, stage.botId, {
      text: "Once.",
      requestId: "req-42",
      channelKey: "support",
    });
    const b = await create(stage.u.mario, stage.botId, {
      text: "Once.",
      requestId: "req-42",
      channelKey: "support",
    });
    expect(b.status).toBe(200);
    expect(b.body.deduped).toBe(true);
    expect(b.body.conversation.id).toBe(a.body.conversation.id);
    expect(a.body.channel.name).toBe("support");
    const rows = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.requestId, "req-42"));
    expect(rows).toHaveLength(1);
  });

  test("a disabled bot takes no new conversations", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { enabled: false },
    );
    const res = await create(stage.u.mario, stage.botId, { text: "Hi" });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("botId");
    expect(res.body.error?.message).toContain("disabled");
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { enabled: true },
    );
  });

  test("a project without its default and fast models says who sets them", async () => {
    const { u } = stage;
    const bot = await call<ActionResponse<BotCreate>>(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.peach.projectId}/bot`,
      { name: "Lonely", persona: "Alone." },
    );
    const res = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.peach.projectId}/bot/${bot.body.bot.id}/conversation`,
      { text: "Hello?" },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain("Settings → Models");
  });
});

describe("callbacks and the callback secret", () => {
  test("a callback needs the bot's secret first; rotating needs write access and shows it once", async () => {
    const without = await create(stage.u.mario, secretBotId, {
      text: "Call me.",
      callbackUrl: "http://127.0.0.1:9/hook",
    });
    expect(without.status).toBe(406);
    expect(without.body.error?.key).toBe("callbackUrl");
    expect(without.body.error?.message).toContain("bot:rotate-callback-secret");

    // Luigi cannot read the vault bot: the same 404 as no bot.
    const luigi = await call(
      stage.u.url,
      stage.u.luigi,
      "POST",
      `/project/${stage.u.projectId}/bot/${secretBotId}/callback-secret`,
    );
    expect(luigi.status).toBe(404);

    const rotated = await call<ActionResponse<BotRotateCallbackSecret>>(
      stage.u.url,
      stage.u.mario,
      "POST",
      `/project/${stage.u.projectId}/bot/${secretBotId}/callback-secret`,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.callbackSecret).toMatch(/^hyp_cbs_/);
    expect(rotated.body.bot.hasCallbackSecret).toBe(true);
    const view = await call(
      stage.u.url,
      stage.u.mario,
      "GET",
      `/project/${stage.u.projectId}/bot/${secretBotId}`,
    );
    expect(JSON.stringify(view.body)).not.toContain(
      rotated.body.callbackSecret,
    );
    const audit = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "bot:rotate-callback-secret"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(rotated.body.callbackSecret);

    const withIt = await create(stage.u.mario, secretBotId, {
      text: "Call me.",
      callbackUrl: "http://127.0.0.1:9/hook",
    });
    expect(withIt.status).toBe(200);
  });

  test("a private callback address is refused when the SSRF guard is on", async () => {
    config.network.allowPrivateHosts = false;
    const res = await create(stage.u.mario, secretBotId, {
      text: "Call me.",
      callbackUrl: "https://127.0.0.1/hook",
    });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("callbackUrl");
    expect(res.body.error?.message).toContain("not a public address");
  });
});

describe("reading", () => {
  test("list: newest first, paginated, filtered, and only bots the caller may read", async () => {
    for (const text of ["L1", "L2", "L3"]) {
      await create(stage.u.mario, secretBotId, { text, title: text });
    }
    const mario = await call<ActionResponse<ConversationList>>(
      stage.u.url,
      stage.u.mario,
      "GET",
      `/project/${stage.u.projectId}/conversations?botId=${secretBotId}&limit=2`,
    );
    expect(mario.status).toBe(200);
    expect(mario.body.conversations).toHaveLength(2);
    expect(mario.body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(mario.body.conversations[0].bot.name).toBe("Vault");
    expect(mario.body.conversations[0].title).toBe("L3");

    const toad = await call<ActionResponse<ConversationList>>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `/project/${stage.u.projectId}/conversations?limit=100`,
    );
    expect(toad.status).toBe(200);
    expect(toad.body.conversations.every((c) => c.botId === stage.botId)).toBe(
      true,
    );
    expect(toad.body.pagination.total).toBe(toad.body.conversations.length);

    const working = await call<ActionResponse<ConversationList>>(
      stage.u.url,
      stage.u.mario,
      "GET",
      `/project/${stage.u.projectId}/conversations?state=ended`,
    );
    expect(working.body.conversations.every((c) => c.state === "ended")).toBe(
      true,
    );
  });

  test("view and entries, with since and pagination", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi!" } }] },
    ]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    await clearLoopQueues();
    await call(stage.u.url, stage.u.peach, "GET", "/status");
    const { enqueueTick } = await import("../../ops/ConversationOps");
    const { conversationRow } = await import("../agent/harness");
    await enqueueTick(await conversationRow(id));
    await runTicks();
    const view = await call<{
      conversation: { state: string; lastSeq: number };
      bot: { name: string };
      standing: { canCancel: boolean };
    }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `/project/${stage.u.projectId}/conversation/${id}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.conversation.state).toBe("hibernating");
    expect(view.body.bot.name).toBe("Toadsworth");
    expect(view.body.standing.canCancel).toBe(true);

    const all = await readEntries(stage, id);
    expect(all.entries.length).toBe(view.body.conversation.lastSeq);
    const tail = await readEntries(stage, id, 4);
    expect(tail.entries[0].seq).toBe(5);
    const page = await call<{
      entries: { seq: number }[];
      pagination: { total: number };
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/conversation/${id}/entries?limit=2&page=2`,
    );
    expect(page.body.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.body.pagination.total).toBe(all.entries.length);
  });
});

describe("who may", () => {
  test("a member without the bot's read tag gets the same refusal as for a missing conversation, on every route", async () => {
    const res = await create(stage.u.mario, secretBotId, { text: "Secret." });
    const id = res.body.conversation.id;
    const missing = 2_000_000_000;
    const routes = (cid: number) =>
      [
        ["GET", `/project/${stage.u.projectId}/conversation/${cid}`],
        ["GET", `/project/${stage.u.projectId}/conversation/${cid}/entries`],
        [
          "PUT",
          `/project/${stage.u.projectId}/conversation/${cid}/message`,
          { text: "x" },
        ],
        ["POST", `/project/${stage.u.projectId}/conversation/${cid}/cancel`],
      ] as const;
    for (const [i, [method, path, body]] of routes(id).entries()) {
      const hidden = await call(stage.u.url, stage.u.toad, method, path, body);
      const [, missingPath, missingBody] = routes(missing)[i];
      const absent = await call(
        stage.u.url,
        stage.u.toad,
        method,
        missingPath,
        missingBody,
      );
      expect(hidden.status, path).toBe(404);
      expect(absent.status).toBe(404);
      expect(hidden.body.error?.message).toBe(absent.body.error?.message ?? "");
      expect(hidden.body.error?.key).toBe(absent.body.error?.key);
    }
    // Creating a conversation with the bot: the same 404 as a missing bot.
    const hiddenBot = await create(stage.u.toad, secretBotId, { text: "x" });
    const missingBot = await create(stage.u.toad, missing, { text: "x" });
    expect(hiddenBot.status).toBe(404);
    expect(hiddenBot.body.error?.message).toBe(
      missingBot.body.error?.message ?? "",
    );
  });

  test("an outsider is refused everything", async () => {
    const res = await create(stage.u.mario, stage.botId, { text: "Hi." });
    const id = res.body.conversation.id;
    for (const [method, path] of [
      ["GET", `/project/${stage.u.projectId}/conversations`],
      ["GET", `/project/${stage.u.projectId}/conversation/${id}`],
      ["POST", `/project/${stage.u.projectId}/conversation/${id}/cancel`],
    ] as const) {
      const bowser = await call(stage.u.url, stage.u.bowser, method, path);
      expect(bowser.status, path).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(bowser.body)).not.toContain("Hi.");
    }
    const sent = await sendMessage(stage, id, "Let me in.", {}, stage.u.bowser);
    expect(sent.status).toBeGreaterThanOrEqual(400);
    const created = await create(stage.u.bowser, stage.botId, { text: "x" });
    expect(created.status).toBeGreaterThanOrEqual(400);
  });

  test("anyone who may read the bot may talk to it and cancel", async () => {
    const res = await create(stage.u.luigi, stage.botId, { text: "Hi." });
    expect(res.status).toBe(200);
    const cancelled = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${stage.u.projectId}/conversation/${res.body.conversation.id}/cancel`,
    );
    expect(cancelled.status).toBe(200);
  });
});
