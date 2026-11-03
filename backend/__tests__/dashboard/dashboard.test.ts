import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import type { ConversationEntries } from "../../actions/conversation/conversation-entries";
import type { ConversationList } from "../../actions/conversation/conversation-list";
import type { ConversationOutbox } from "../../actions/conversation/conversation-outbox";
import type { ConversationView } from "../../actions/conversation/conversation-view";
import type { InboxList } from "../../actions/inbox/inbox-list";
import type { ProjectOverview } from "../../actions/project/project-overview";
import { slackUrl } from "../../ops/ConversationLinkOps";
import { botDashboardChannel } from "../../ops/DashboardEffectsOps";
import { approvals } from "../../schema/approvals";
import { auditLogs } from "../../schema/audit_logs";
import { helpRequests } from "../../schema/help_requests";
import { outboxMessages } from "../../schema/outbox_messages";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import {
  type AgentStage,
  buildAgentStage,
  conversationRow,
  runTicks,
  shape,
  startConversation,
} from "../agent/harness";
import { call, createTag, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * Mission control: `project:overview`, `inbox:list`, `conversation:list`'s
 * filters, `conversation:outbox`, `conversation:retry`, backwards paging of
 * `conversation:entries`, and the per-bot dashboard channel. The whole-set
 * gating assertion holds every read and the channel to one rule: a member
 * who cannot read a bot learns nothing about it — no row, no count, no hit,
 * no frame.
 */
let stage: AgentStage;
let vaultBotId: number;
let archiveBotId: number;
let stewardConversation: number;
let vaultConversation: number;

/**
 * Open a socket with a session.
 * @param session - The session id.
 * @returns The socket and its message log.
 */
async function openSocket(session?: string) {
  const socket = new WebSocket(stage.u.url.replace(/^http/, "ws"), {
    headers: session
      ? { Cookie: `${config.session.cookieName}=${session}` }
      : {},
  });
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  return { socket, messages };
}

/**
 * Subscribe and report the answer.
 * @param socket - The socket.
 * @param messages - Its log.
 * @param channel - The channel.
 * @returns Whether it was accepted, and the refusal if not.
 */
async function subscribe(
  socket: WebSocket,
  messages: unknown[],
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  socket.send(JSON.stringify({ messageType: "subscribe", channel }));
  const deadline = Date.now() + 5_000;
  for (;;) {
    for (const raw of messages) {
      const m = raw as {
        subscribed?: { channel: string };
        error?: { message?: string };
      };
      if (m.subscribed?.channel === channel) return { ok: true };
      if (m.error) return { ok: false, error: m.error.message };
    }
    if (Date.now() > deadline) return { ok: false, error: "no answer" };
    await Bun.sleep(20);
  }
}

/**
 * The broadcast payloads a socket received on one channel, past presence.
 * @param messages - Its log.
 * @param channel - Only frames on this channel.
 * @returns Each frame's parsed payload.
 */
function frames(messages: unknown[], channel: string): unknown[] {
  return messages.flatMap((raw) => {
    const frame = raw as { message?: { channel?: string; message?: string } };
    if (typeof frame.message?.message !== "string") return [];
    if (frame.message.channel && frame.message.channel !== channel) return [];
    const payload = JSON.parse(frame.message.message) as { event?: string };
    return payload.event === "join" || payload.event === "leave"
      ? []
      : [payload];
  });
}

/**
 * GET as someone.
 * @param user - Who.
 * @param path - The path.
 * @returns The status and body.
 */
function get<T>(user: TestUser, path: string) {
  return call<T>(stage.u.url, user, "GET", path);
}

/**
 * Write a pending approval, help request, and sandbox question for a bot's
 * conversation, as the gate, `escalate_to_human`, and `sandbox:ask` would.
 * @param botId - The bot.
 * @param conversationId - Its conversation.
 */
async function seedInbox(botId: number, conversationId: number) {
  const projectId = stage.u.projectId;
  const later = new Date(Date.now() + 3_600_000);
  await api.db.db.insert(approvals).values({
    projectId,
    botId,
    conversationId,
    callKey: `seed-${botId}`,
    server: "linear",
    tool: "issue_delete",
    args: {},
    expiresAt: later,
  });
  await api.db.db.insert(helpRequests).values({
    projectId,
    botId,
    conversationId,
    question: `Which tower for bot ${botId}?`,
    expiresAt: later,
  });
  const [job] = await api.db.db
    .insert(sandboxJobs)
    .values({
      projectId,
      botId,
      parentConversationId: conversationId,
      title: `Fix the drawbridge ${botId}`,
      task: "Fix it.",
      status: "running",
      maxDurationMs: 60_000,
      idleTimeoutMs: 60_000,
    })
    .returning();
  await api.db.db.insert(sandboxJobQuestions).values({
    jobId: job.id,
    kind: "conversation",
    question: "Which branch?",
    expiresAt: later,
  });
  // A question to the team is a help request already; never listed twice.
  await api.db.db.insert(sandboxJobQuestions).values({
    jobId: job.id,
    kind: "team",
    question: "Team, which branch?",
    expiresAt: later,
  });
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  const { u } = stage;
  const staff = await createTag(u.url, u.peach, u.projectId, "vault-staff");
  await call(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/member/${u.mario.userId}/tag/${staff}`,
  );
  const vault = await call<ActionResponse<BotCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/bot`,
    { name: "Vault", persona: "Guard.", accessRead: ["vault-staff"] },
  );
  vaultBotId = vault.body.bot.id;
  const archive = await call<ActionResponse<BotCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/bot`,
    { name: "Archive", persona: "Keeper.", accessWrite: ["vault-staff"] },
  );
  archiveBotId = archive.body.bot.id;
  stage.models.play([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Hello." } }] },
  ]);
  stewardConversation = (await startConversation(stage, "Hi steward.")).body
    .conversation.id;
  await runTicks();
  const res = await call<{ conversation: { id: number } }>(
    u.url,
    u.mario,
    "PUT",
    `/project/${u.projectId}/bot/${vaultBotId}/conversation`,
    { text: "Secret." },
  );
  vaultConversation = res.body.conversation.id;
  await seedInbox(stage.botId, stewardConversation);
  await seedInbox(vaultBotId, vaultConversation);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("gating, whole set", () => {
  test("a member who cannot read a bot sees no row, count, item, or frame of it", async () => {
    const p = stage.u.projectId;
    const toad = stage.u.toad;
    const overview = await get<ActionResponse<ProjectOverview>>(
      toad,
      `/project/${p}/overview`,
    );
    expect(overview.status).toBe(200);
    const o = overview.body.overview;
    const botIds = o.bots.map((b) => b.id).sort();
    expect(botIds).toEqual([stage.botId, archiveBotId].sort());
    expect(o.recent.map((c) => c.botId)).not.toContain(vaultBotId);
    // The steward's three items only; the team question is not counted twice.
    expect(o.inbox).toEqual({
      approval: 1,
      help: 1,
      "sandbox-question": 1,
      total: 3,
    });

    const inbox = await get<ActionResponse<InboxList>>(
      toad,
      `/project/${p}/inbox?limit=100`,
    );
    expect(inbox.body.pagination.total).toBe(3);
    expect(inbox.body.items.map((i) => i.bot.id)).toEqual([
      stage.botId,
      stage.botId,
      stage.botId,
    ]);
    const filtered = await get<ActionResponse<InboxList>>(
      toad,
      `/project/${p}/inbox?botId=${vaultBotId}`,
    );
    expect(filtered.body.items).toEqual([]);
    expect(filtered.body.pagination.total).toBe(0);

    const list = await get<ActionResponse<ConversationList>>(
      toad,
      `/project/${p}/conversations?limit=100`,
    );
    expect(list.body.conversations.map((c) => c.botId)).not.toContain(
      vaultBotId,
    );
    const outbox = await get(
      toad,
      `/project/${p}/conversation/${vaultConversation}/outbox`,
    );
    expect(outbox.status).toBe(404);

    const { socket, messages } = await openSocket(toad.sessionId);
    try {
      const refused = await subscribe(
        socket,
        messages,
        botDashboardChannel(p, vaultBotId),
      );
      expect(refused.ok).toBe(false);
    } finally {
      socket.close();
    }
  });

  test("a reader of every bot sees every bot's items", async () => {
    const p = stage.u.projectId;
    const overview = await get<ActionResponse<ProjectOverview>>(
      stage.u.mario,
      `/project/${p}/overview`,
    );
    expect(overview.body.overview.bots.map((b) => b.id)).toContain(vaultBotId);
    expect(overview.body.overview.inbox.total).toBe(6);
    const inbox = await get<ActionResponse<InboxList>>(
      stage.u.mario,
      `/project/${p}/inbox?kind=sandbox-question`,
    );
    expect(inbox.body.items).toHaveLength(2);
    for (const item of inbox.body.items) {
      expect(item.kind).toBe("sandbox-question");
      expect(item.jobId).not.toBeNull();
    }
  });

  test("an outsider is refused every read and the channel", async () => {
    const p = stage.u.projectId;
    const bowser = stage.u.bowser;
    for (const path of [
      `/project/${p}/overview`,
      `/project/${p}/inbox`,
      `/project/${p}/conversation/${stewardConversation}/outbox`,
    ]) {
      expect((await get(bowser, path)).status).not.toBe(200);
    }
    const { socket, messages } = await openSocket(bowser.sessionId);
    try {
      expect(
        (await subscribe(socket, messages, botDashboardChannel(p, stage.botId)))
          .ok,
      ).toBe(false);
    } finally {
      socket.close();
    }
  });
});

describe("project:overview", () => {
  test("counts conversations by state and waiting kind", async () => {
    await api.db.db
      .update((await import("../../schema/conversations")).conversations)
      .set({
        state: "waiting",
        waitingOn: { kind: "timer", at: Date.now() + 60_000 },
      })
      .where(
        eq(
          (await import("../../schema/conversations")).conversations.id,
          stewardConversation,
        ),
      );
    const overview = await get<ActionResponse<ProjectOverview>>(
      stage.u.peach,
      `/project/${stage.u.projectId}/overview`,
    );
    const steward = overview.body.overview.bots.find(
      (b) => b.id === stage.botId,
    );
    expect(steward?.counts.waiting.timer).toBe(1);
    expect(steward?.counts.waitingTotal).toBe(1);
    expect(steward?.needsPerson).toBe(3);
    expect(typeof steward?.spendToday.usd).toBe("number");
    const list = await get<ActionResponse<ConversationList>>(
      stage.u.peach,
      `/project/${stage.u.projectId}/conversations?waitingKind=timer`,
    );
    expect(list.body.conversations.map((c) => c.id)).toEqual([
      stewardConversation,
    ]);
    const none = await get<ActionResponse<ConversationList>>(
      stage.u.peach,
      `/project/${stage.u.projectId}/conversations?waitingKind=approval`,
    );
    expect(none.body.conversations).toEqual([]);
  });
});

describe("frames", () => {
  test("a reader's socket gets content-free frames for its bot, and none for another's", async () => {
    const p = stage.u.projectId;
    const toad = await openSocket(stage.u.toad.sessionId);
    const mario = await openSocket(stage.u.mario.sessionId);
    const stewardChannel = botDashboardChannel(p, stage.botId);
    const vaultChannel = botDashboardChannel(p, vaultBotId);
    try {
      expect(
        (await subscribe(toad.socket, toad.messages, stewardChannel)).ok,
      ).toBe(true);
      expect(
        (await subscribe(mario.socket, mario.messages, vaultChannel)).ok,
      ).toBe(true);
      stage.models.play([
        { toolCalls: [{ name: "reply_and_wait", input: { text: "Shh." } }] },
      ]);
      await call(
        stage.u.url,
        stage.u.mario,
        "PUT",
        `/project/${p}/conversation/${vaultConversation}/message`,
        { text: "Again." },
      );
      await runTicks();
      const deadline = Date.now() + 5_000;
      while (
        frames(mario.messages, vaultChannel).length === 0 &&
        Date.now() < deadline
      ) {
        await Bun.sleep(25);
      }
      const vaultFrames = frames(mario.messages, vaultChannel);
      expect(vaultFrames.length).toBeGreaterThan(0);
      for (const frame of vaultFrames) {
        expect(Object.keys(frame as object).sort()).toEqual(["event", "stale"]);
        expect(["conversations", "inbox", "sandboxes"]).toContain(
          (frame as { stale: string }).stale,
        );
      }
      // Toad follows the steward only: the vault's activity reached nothing.
      expect(frames(toad.messages, stewardChannel)).toEqual([]);
    } finally {
      toad.socket.close();
      mario.socket.close();
    }
  });
});

describe("conversation:retry", () => {
  test("a failed turn is retried by a bot writer, audited, and told to the model", async () => {
    const p = stage.u.projectId;
    stage.models.play([
      { toolCalls: [{ name: "fail", input: { reason: "No key." } }] },
    ]);
    const id = (await startConversation(stage, "Open the tower.")).body
      .conversation.id;
    await runTicks();
    expect((await conversationRow(id)).outcome).toBe("failed");
    const view = await get<ActionResponse<ConversationView>>(
      stage.u.peach,
      `/project/${p}/conversation/${id}`,
    );
    expect(view.body.standing.canRetry).toBe(true);

    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Found it." } }] },
    ]);
    const retried = await call<{ conversation: { state: string } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${p}/conversation/${id}/retry`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.conversation.state).toBe("working");
    await runTicks();
    const row = await conversationRow(id);
    expect(row.state).toBe("hibernating");
    expect(await shape(id)).toContain("status_change:working→working");
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "conversation:retry"),
          eq(auditLogs.targetPath, String(id)),
        ),
      );
    expect(audit).toBeDefined();

    const again = await call<{ error?: { message: string } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${p}/conversation/${id}/retry`,
    );
    expect(again.status).not.toBe(200);
    expect(JSON.stringify(again.body)).toContain(
      "Only a conversation whose turn failed",
    );
  });

  test("a reader who cannot write the bot is refused", async () => {
    const p = stage.u.projectId;
    stage.models.play([
      { toolCalls: [{ name: "fail", input: { reason: "Dusty." } }] },
    ]);
    const created = await call<{ conversation: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${p}/bot/${archiveBotId}/conversation`,
      { text: "Find the scroll." },
    );
    await runTicks();
    const id = created.body.conversation.id;
    expect((await conversationRow(id)).outcome).toBe("failed");
    const view = await get<ActionResponse<ConversationView>>(
      stage.u.toad,
      `/project/${p}/conversation/${id}`,
    );
    expect(view.body.standing.canRetry).toBe(false);
    const refused = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${p}/conversation/${id}/retry`,
    );
    expect(refused.status).not.toBe(200);
    expect((await conversationRow(id)).state).toBe("ended");
  });
});

describe("conversation:outbox and paging", () => {
  test("the outbox lists what was sent, newest first, without a callback's query", async () => {
    for (const seq of [1, 2]) {
      await api.db.db.insert(outboxMessages).values({
        projectId: stage.u.projectId,
        conversationId: stewardConversation,
        seq,
        kind: "reply",
        payload: { text: `Reply ${seq}` },
        target: {
          type: "api-callback",
          url: "https://example.com/hook?token=caller-secret#frag",
        },
      });
    }
    const outbox = await get<ActionResponse<ConversationOutbox>>(
      stage.u.peach,
      `/project/${stage.u.projectId}/conversation/${stewardConversation}/outbox`,
    );
    expect(outbox.status).toBe(200);
    expect(outbox.body.outbox.length).toBeGreaterThan(0);
    const ids = outbox.body.outbox.map((r) => r.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(outbox.body.outbox[0].target).toEqual({
      type: "api-callback",
      url: "https://example.com/hook",
    });
    expect(JSON.stringify(outbox.body)).not.toContain("caller-secret");
  });

  test("entries page backwards from the newest", async () => {
    const base = `/project/${stage.u.projectId}/conversation/${stewardConversation}/entries`;
    const tail = await get<ActionResponse<ConversationEntries>>(
      stage.u.peach,
      `${base}?order=desc&limit=2`,
    );
    const seqs = tail.body.entries.map((e) => e.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[0]).toBeGreaterThan(seqs[1]);
    const older = await get<ActionResponse<ConversationEntries>>(
      stage.u.peach,
      `${base}?order=desc&limit=2&before=${seqs[1]}`,
    );
    for (const e of older.body.entries) expect(e.seq).toBeLessThan(seqs[1]);
  });
});

describe("platform links", () => {
  test("a Slack link is built from Slack's ids only", () => {
    expect(slackUrl("T123", "C456", "1700000000.000200")).toBe(
      "https://app.slack.com/client/T123/C456/thread/C456-1700000000.000200",
    );
    expect(slackUrl("T123", "C456", null)).toBe(
      "https://app.slack.com/client/T123/C456",
    );
    expect(slackUrl("T123", "C456/../evil", "1.2")).toBeNull();
  });
});
