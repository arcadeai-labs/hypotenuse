import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { clearLoopQueues } from "../agent/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import { type ConformanceDriver, conformance } from "./conformance";
import {
  buildChannelStage,
  type ChannelStage,
  conversationFor,
  lastEvent,
  resetChannels,
  settle,
} from "./harness";

/**
 * The conformance suite against the generic webhook platform, through its
 * fake over the real wire: signed deliveries in, signed deliveries out.
 */
let stage: ChannelStage;
let fixture: McpFixture;

beforeAll(async () => {
  stage = await buildChannelStage();
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
  await resetChannels();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.platform.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.platform.reset();
  fixture.reset();
});

afterAll(async () => {
  await fixture.stop();
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A delivery in #general from Peach, mentioning the bot. */
const base = {
  channel: { id: "C-general", name: "general" },
  conversation: "T-wire",
  mentions: true,
};

const driver = (): ConformanceDriver => ({
  models: stage.models,
  async say(thread, text) {
    await stage.platform.send({ ...base, conversation: thread, text });
    await settleIngress();
    return (await conversationFor(thread)).id;
  },
  settle: () => settle(),
  async shown(conversationId) {
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return stage.platform.deliveries
      .filter((d) => d.conversation === c.externalConversationKey)
      .map((d) => d as { kind: string });
  },
  async statuses(conversationId) {
    const { drainQueue } = await import("../agent/harness");
    await drainQueue("outbox");
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return stage.platform.deliveries
      .filter(
        (d) =>
          d.conversation === c.externalConversationKey && d.kind === "status",
      )
      .map((d) => String(d.text));
  },
  async pressAnswer(conversationId, questionEntryId, label) {
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    await stage.platform.send({
      ...base,
      conversation: String(c.externalConversationKey),
      type: "interaction",
      interaction: {
        kind: "answer",
        targetId: String(questionEntryId),
        value: label,
      },
    });
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
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    await stage.platform.send({
      ...base,
      conversation: String(c.externalConversationKey),
      sender: { id: as, name: as },
      type: "interaction",
      interaction: {
        kind: "approval",
        targetId: String(approvalId),
        value: approve ? "approve" : "deny",
      },
    });
    await settleIngress();
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
  wire: {
    send: (draft) => stage.platform.send({ ...base, ...draft }),
    sendToUnknownKey: () =>
      stage.platform.sendRaw(
        JSON.stringify({
          ...base,
          messageId: "x",
          sender: { id: "U" },
          text: "hi",
        }),
        `${stage.u.url}/api/webhooks/webhook/hyp_rk_nobodyhasthiskey`,
      ),
    async sendBadSignature() {
      stage.platform.signWith = "the-wrong-secret-entirely";
      try {
        return await stage.platform.sendRaw(
          JSON.stringify({
            ...base,
            messageId: "y",
            sender: { id: "U" },
            text: "hi",
          }),
        );
      } finally {
        stage.platform.signWith = null;
      }
    },
    async uninstall() {
      await stage.platform.send({
        ...base,
        type: "lifecycle",
        lifecycle: "uninstall",
      });
    },
    lastOutcome: async () => (await lastEvent())?.outcome ?? null,
  },
});

/** Process events only, so a test can act before ticks run. */
async function settleIngress() {
  const { drainQueue } = await import("../agent/harness");
  await drainQueue("ingress");
}

describe("the webhook platform conforms", () => {
  conformance("webhook", driver);
});
