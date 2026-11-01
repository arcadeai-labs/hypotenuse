import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { clearLoopQueues, drainQueue } from "../agent/harness";
import {
  type ConformanceDriver,
  conformance,
  type Shown,
} from "../channels/conformance";
import { lastEvent, settle } from "../channels/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  BOT_NAME,
  buildPylonStage,
  type PylonStage,
  resetPylon,
  text,
} from "./harness";

/**
 * The conformance suite against Pylon, through the Pylon fake over the real
 * wire: issues, messages, and notes in as signed Trigger webhooks, internal
 * notes out — read back from the issue as a teammate in Pylon sees them. A
 * thread's first message opens an issue as the customer; later ones are a
 * teammate's notes mentioning the bot. Pylon has no status line (a note is
 * permanent), so the supersession case does not apply; the `listed` policy
 * and the webhook-shaped wire case are not run, and Pylon's own wire cases
 * (signatures, the 404, loops) live in `install.test.ts` and `issue.test.ts`.
 */
let stage: PylonStage;
let fixture: McpFixture;
/** Each conformance thread's name, and its issue. */
const threads = new Map<string, string>();

beforeAll(async () => {
  stage = await buildPylonStage();
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
  await resetPylon();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.pylon.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.pylon.clearRequests();
  fixture.reset();
  threads.clear();
});

afterAll(async () => {
  config.platforms.pylon.apiUrlUs = stage.saved.apiUrlUs;
  config.platforms.pylon.apiUrlEu = stage.saved.apiUrlEu;
  await fixture.stop();
  await stage.pylon.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A conversation's issue.
 * @param conversationId - The conversation.
 * @returns The issue id.
 */
async function issueOf(conversationId: number): Promise<string> {
  const [c] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return String(c.externalConversationKey).slice("issue:".length);
}

/**
 * Deliver what Pylon has, and process it, without running ticks.
 */
async function ingest() {
  await stage.pylon.drain();
  await drainQueue("ingress");
  await drainQueue("outbox");
}

/**
 * The newest conversation.
 * @returns It.
 */
async function newest() {
  const rows = await api.db.db
    .select()
    .from(conversations)
    .orderBy(conversations.id);
  return rows[rows.length - 1];
}

/**
 * A teammate's note to the bot, delivered and processed.
 * @param issueId - The issue.
 * @param body - What they wrote.
 */
async function noteToBot(issueId: string, body: string) {
  stage.pylon.teammateWrites(issueId, stage.teammate, `@${BOT_NAME} ${body}`);
  await ingest();
}

const driver = (): ConformanceDriver => ({
  models: stage.models,
  async say(thread, said) {
    const known = threads.get(thread);
    if (known) {
      await noteToBot(known, said);
      return (await newest()).id;
    }
    const issue = stage.pylon.openIssue({
      contactId: stage.acme.contactId,
      title: said,
      body: said,
    });
    await ingest();
    threads.set(thread, issue.id);
    return (await newest()).id;
  },
  async settle() {
    for (let i = 0; i < 3; i++) {
      await ingest();
      await settle();
    }
  },
  async shown(conversationId) {
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const notes = stage.pylon
      .notesOn(await issueOf(conversationId))
      .filter((n) => n.author.user?.id === stage.conn.userId);
    const out: Shown[] = [];
    notes.forEach((n, i) => {
      const plain = text(n.message_html);
      if (plain === "Looking into this.") return;
      const approval =
        /waiting for approval \(#(\d+)\)|run `?[^(]*\(#(\d+)\)/.exec(plain);
      const approvalId = /\(#(\d+)\)/.exec(plain)?.[1];
      if (approval && approvalId) {
        out.push({ kind: "approval", id: i, approvalId: Number(approvalId) });
      } else if (plain.startsWith("A question for the team")) {
        const options = [...n.message_html.matchAll(/<li>(.*?)<\/li>/g)].map(
          (m) => m[1],
        );
        out.push({
          kind: "question",
          id: i,
          text: plain,
          ...(options.length > 0 ? { options } : {}),
          questionEntryId:
            c.waitingOn?.kind === "answer" ? c.waitingOn.questionEntryId : 0,
        });
      } else {
        out.push({
          kind: "message",
          id: i,
          text: plain.replace(/\s*Steps\s.*$/, ""),
        });
      }
    });
    return out;
  },
  async statuses() {
    return [];
  },
  noStatusLine: true,
  async pressAnswer(conversationId, _questionEntryId, label) {
    await noteToBot(await issueOf(conversationId), label);
  },
  policies: ["dashboard", "participants"],
  async setPolicy(conversationId, policy, listed = []) {
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    await api.db.db
      .update(channelBindings)
      .set({ approvalPolicy: policy, approverExternalIds: listed })
      .where(
        and(
          eq(channelBindings.botId, c.botId),
          eq(channelBindings.channelId, c.channelId),
        ),
      );
  },
  async decide(conversationId, approvalId, approve) {
    stage.pylon.teammateWrites(
      await issueOf(conversationId),
      stage.teammate,
      `${approve ? "approve" : "deny"} ${approvalId}`,
    );
    await ingest();
    return (await lastEvent()).outcome === "interaction";
  },
  async decideInDashboard(approvalId) {
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approvalId}`,
      { decision: "approve", via: "dashboard" },
    );
    expect(res.status).toBe(200);
  },
});

describe("Pylon conforms", () => {
  // Coverage: `pylon.conformance`.
  conformance("pylon", driver);
});
