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
import type { SlackMessage } from "../fakes/slack/server";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildSlackStage,
  conversationForThread,
  resetSlack,
  type SlackStage,
} from "./harness";

/**
 * The conformance suite against Slack, through the Slack fake over the real
 * wire: v0-signed events and `block_actions` in, Web API calls out — read
 * back as what a person in the thread sees. The wire-only cases (loops,
 * dedupe, the 404, uninstall) are Slack-shaped and live in `install.test.ts`
 * and `thread.test.ts`.
 */
let stage: SlackStage;
let fixture: McpFixture;
/** Each conformance thread's name, and the `ts` of the message that started it. */
const threads = new Map<string, string>();
const CHANNEL = "C0GENERAL";

beforeAll(async () => {
  stage = await buildSlackStage();
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
  await resetSlack();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.slack.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.slack.reset();
  fixture.reset();
  threads.clear();
});

afterAll(async () => {
  config.platforms.slack.apiUrl = stage.apiUrl;
  await fixture.stop();
  await stage.slack.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A conversation's Slack thread.
 * @param conversationId - The conversation.
 * @returns Its `ts`.
 */
async function threadOf(conversationId: number): Promise<string> {
  const [c] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return String(c.externalConversationKey);
}

/**
 * Read one of the bot's Slack messages back as the surface kind it shows.
 * @param m - The message.
 * @param i - Its place in the thread.
 * @returns What a person sees.
 */
function asShown(m: SlackMessage, i: number): Shown {
  const blocks = (m.blocks ?? []) as {
    type: string;
    elements?: {
      action_id?: string;
      value?: string;
      text?: string;
      options?: { value: string }[];
    }[];
  }[];
  const elements = blocks.flatMap((b) =>
    b.type === "actions" ? (b.elements ?? []) : [],
  );
  const question = elements.find((e) => e.action_id?.startsWith("q:"));
  if (
    !question &&
    JSON.stringify(blocks).includes("Or reply in this thread.")
  ) {
    return { kind: "question", id: i, text: m.text, ts: m.ts };
  }
  if (question) {
    const options = question.options
      ? question.options.map((o) => o.value)
      : elements.map((e) => String(e.value));
    return {
      kind: "question",
      id: i,
      text: m.text,
      options,
      questionEntryId: Number(question.action_id?.split(":")[1]),
      ts: m.ts,
    };
  }
  const link = /approvals\/(\d+)/.exec(JSON.stringify(blocks));
  if (link) {
    return { kind: "approval", id: i, approvalId: Number(link[1]), ts: m.ts };
  }
  if (
    blocks.some((b) => b.type === "context") &&
    m.text.startsWith("Working:")
  ) {
    return { kind: "plan", id: i, text: m.text, ts: m.ts };
  }
  return { kind: "message", id: i, text: m.text, ts: m.ts };
}

const driver = (): ConformanceDriver => ({
  models: stage.models,
  async say(thread, text) {
    const known = threads.get(thread);
    const said = await stage.slack.say({
      channel: CHANNEL,
      text,
      mention: true,
      ...(known ? { threadTs: known } : {}),
    });
    if (!known) threads.set(thread, said.ts);
    await drainQueue("ingress");
    return (await conversationForThread(known ?? said.ts)).id;
  },
  settle: () => settle(),
  async shown(conversationId) {
    const ts = await threadOf(conversationId);
    return stage.slack
      .botMessages(CHANNEL, ts)
      .map(asShown)
      .filter((s) => s.kind !== "plan");
  },
  async statuses(conversationId) {
    await drainQueue("outbox");
    const ts = await threadOf(conversationId);
    return stage.slack.statuses
      .filter((s) => s.threadTs === ts)
      .map((s) => s.status);
  },
  async pressAnswer(conversationId, _questionEntryId, label) {
    const ts = await threadOf(conversationId);
    const q = stage.slack
      .botMessages(CHANNEL, ts)
      .map(asShown)
      .find((s) => s.kind === "question");
    const options = (q?.options as string[]) ?? [];
    await stage.slack.press(
      String(q?.ts),
      `q:${q?.questionEntryId}:${options.indexOf(label)}`,
      {
        value: label,
      },
    );
  },
  policies: ["dashboard", "participants", "listed"],
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
  async decide(conversationId, approvalId, approve, as = "U-peach") {
    const ts = await threadOf(conversationId);
    const card = stage.slack
      .botMessages(CHANNEL, ts)
      .map(asShown)
      .find((s) => s.kind === "approval" && s.approvalId === approvalId);
    await stage.slack.press(
      String(card?.ts),
      `a:${approvalId}:${approve ? "approve" : "deny"}`,
      {
        user: as,
        value: approve ? "approve" : "deny",
      },
    );
    await drainQueue("ingress");
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

describe("Slack conforms", () => {
  // Coverage: `slack.out.question`, `slack.in.block-actions`.
  conformance("slack", driver);
});
