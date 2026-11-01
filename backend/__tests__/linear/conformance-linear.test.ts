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
  buildLinearStage,
  createIssue,
  delegate,
  type LinearStage,
  newestConversation,
  resetLinear,
  sessionOf,
} from "./harness";

/**
 * The conformance suite against Linear, through finear over the real wire:
 * delegations and prompts in as signed webhooks, agent activities out — read
 * back from the session as a person in Linear sees it. Linear's own wire cases
 * (the signature, a workspace never refused, revocation) live in
 * `install.test.ts` and `session.test.ts`: Linear acknowledges an uninstalled
 * app's deliveries rather than answering the 404 the shared case expects.
 * The `listed` policy is not run: finear has one person per workspace, so
 * nobody else can be the listed approver (a gap in the coverage matrix).
 */
let stage: LinearStage;
let fixture: McpFixture;
/** Each conformance thread's name, and its session. */
const threads = new Map<string, string>();

beforeAll(async () => {
  stage = await buildLinearStage();
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
  await resetLinear();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  fixture.reset();
  threads.clear();
});

afterAll(async () => {
  config.platforms.linear.apiUrl = stage.saved.apiUrl;
  config.platforms.linear.authorizeUrl = stage.saved.authorizeUrl;
  await fixture.stop();
  await stage.linear.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A conversation's session.
 * @param conversationId - The conversation.
 * @returns The session id.
 */
async function sessionIdOf(conversationId: number): Promise<string> {
  const [c] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return String(c.externalConversationKey);
}

/**
 * Prompt a session as the fixture person, and process the delivery.
 * @param sessionId - The session.
 * @param body - What they wrote.
 */
async function prompt(sessionId: string, body: string) {
  await stage.linear.control("/__test/agents/prompt", { sessionId, body });
  await stage.linear.drain();
  await drainQueue("ingress");
}

const driver = (): ConformanceDriver => ({
  models: stage.models,
  async say(thread, text) {
    const known = threads.get(thread);
    if (known) {
      await prompt(known, text);
      return (await newestConversation()).id;
    }
    const issue = await createIssue(stage.linear, { description: text });
    await delegate(stage, issue.id);
    await drainQueue("ingress");
    const conversation = await newestConversation();
    threads.set(thread, String(conversation.externalConversationKey));
    return conversation.id;
  },
  settle: () => settle(),
  async shown(conversationId) {
    const [c] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const session = await sessionOf(
      stage.linear,
      String(c.externalConversationKey),
    );
    const out: Shown[] = [];
    session.activities.nodes.forEach((n, i) => {
      const type = n.content.__typename;
      const body = String(n.content.body ?? "");
      if (
        type === "AgentActivityResponseContent" ||
        type === "AgentActivityErrorContent"
      ) {
        out.push({ kind: "message", id: i, text: body });
      } else if (type === "AgentActivityElicitationContent") {
        const approval = /approvals\/(\d+)/.exec(body);
        if (approval) {
          out.push({
            kind: "approval",
            id: i,
            approvalId: Number(approval[1]),
          });
        } else {
          const options = (
            (n.signalMetadata?.options ?? []) as { value: string }[]
          ).map((o) => o.value);
          out.push({
            kind: "question",
            id: i,
            text: body,
            ...(options.length > 0 ? { options } : {}),
            questionEntryId:
              c.waitingOn?.kind === "answer" ? c.waitingOn.questionEntryId : 0,
          });
        }
      }
    });
    return out;
  },
  async statuses(conversationId) {
    await drainQueue("outbox");
    const session = await sessionOf(
      stage.linear,
      await sessionIdOf(conversationId),
    );
    return session.activities.nodes
      .filter((n) => n.content.__typename === "AgentActivityThoughtContent")
      .map((n) => String(n.content.body));
  },
  async pressAnswer(conversationId, _questionEntryId, label) {
    await prompt(await sessionIdOf(conversationId), label);
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
    await prompt(
      await sessionIdOf(conversationId),
      `${approve ? "Approve" : "Deny"} #${approvalId}`,
    );
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

describe("Linear conforms", () => {
  // Coverage: `linear.conformance`.
  conformance("linear", driver);
});
