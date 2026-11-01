import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { emit, emitStatus } from "../../ops/SurfaceOps";
import { approvals } from "../../schema/approvals";
import { auditLogs } from "../../schema/audit_logs";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";
import { conversationEntries } from "../../schema/conversation_entries";
import { conversationInbox } from "../../schema/conversation_inbox";
import { outboxMessages } from "../../schema/outbox_messages";
import {
  clearLoopQueues,
  conversationRow,
  drainQueue,
  startTick,
  untilRequests,
} from "../agent/harness";
import { lastEvent, settle } from "../channels/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { call, HOOK_TIMEOUT } from "../setup";
import { FINEAR } from "./finear";
import {
  buildLinearStage,
  completeLinearInstall,
  conversationForSession,
  createIssue,
  createProject,
  delegate,
  flow,
  inject,
  type LinearStage,
  newestConversation,
  resetLinear,
  sessionOf,
  updateIssue,
} from "./harness";

/**
 * A bot answering Linear agent sessions, end to end through finear: what a
 * person in Linear sees for a delegation — the acknowledgement, the plan, the
 * actions, the answer, a question, an approval — and every way a person
 * tells the bot to stop.
 */
let stage: LinearStage;
let fixture: McpFixture;

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
  stage.linear.clearRequests();
  fixture.reset();
});

afterAll(async () => {
  config.platforms.linear.apiUrl = stage.saved.apiUrl;
  config.platforms.linear.authorizeUrl = stage.saved.authorizeUrl;
  await fixture.stop();
  await stage.linear.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A reply step for the scripted model. */
const reply = (text: string, expect?: Record<string, string>) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
  ...(expect ? { expect } : {}),
});

/**
 * Deliver a conversation's outbox now.
 * @param conversationId - The conversation.
 */
async function deliverNow(conversationId: number) {
  await api.actions.enqueue("outbox:deliver", { conversationId }, "outbox");
  await drainQueue("outbox");
}

/**
 * Delegate a fresh issue and process the `created` delivery and its
 * acknowledgement, without running a tick.
 * @param input - The issue's fields.
 * @returns The issue and its conversation.
 */
async function opened(input: Record<string, unknown> = {}) {
  const issue = await createIssue(stage.linear, input);
  await delegate(stage, issue.id);
  await drainQueue("ingress");
  await drainQueue("outbox");
  const conversation = await newestConversation();
  return {
    issue,
    conversation,
    sessionId: String(conversation.externalConversationKey),
  };
}

/** Prompt a session as the fixture person, and let finear deliver it. */
async function prompt(sessionId: string, body: string) {
  await stage.linear.control("/__test/agents/prompt", { sessionId, body });
  await stage.linear.drain();
}

describe("a session", () => {
  // Coverage: `linear.in.created`, `linear.out.ack`, `linear.out.hygiene`, `linear.out.response`, `linear.channel.team`.
  test("a delegation: acknowledged with a thought, the issue started, answered with a response", async () => {
    stage.models.play([
      { toolCalls: [{ name: "search_history", input: { query: "cake" } }] },
      reply("The cake is in the **kitchen**."),
    ]);
    const { issue, conversation, sessionId } = await opened();
    // The acknowledgement and the hygiene ran before any tick.
    let session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes).toHaveLength(1);
    expect(session.activities.nodes[0].ephemeral).toBe(false);
    expect(session.activities.nodes[0].content.__typename).toBe(
      "AgentActivityThoughtContent",
    );
    expect(session.issue.state.type).toBe("started");
    expect(session.status).toBe("active");
    const [inbox] = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, conversation.id));
    expect(inbox.text).toContain(issue.identifier);
    expect(inbox.text).toContain("Someone hid the cake.");
    const [channel] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.id, conversation.channelId));
    expect(channel.type).toBe("linear");
    expect(channel.externalId).toBe(
      `${FINEAR.primary.organization}/team:${FINEAR.primary.team}`,
    );
    expect(conversation.details.issueId).toBe(issue.id);

    await settle();
    session = await sessionOf(stage.linear, sessionId);
    expect(session.status).toBe("complete");
    const last = session.activities.nodes.at(-1);
    expect(last?.content.__typename).toBe("AgentActivityResponseContent");
    expect(last?.content.body).toBe("The cake is in the **kitchen**.");
  });

  // Coverage: `linear.out.status`, `linear.out.plan`, `linear.out.action`.
  test("a working line is an ephemeral thought; the plan is the session's checklist, with an action per finished step", async () => {
    const { conversation, sessionId } = await opened();
    const c = await conversationRow(conversation.id);
    await emitStatus(api.db.db, c, "Searching memory…");
    await deliverNow(c.id);
    const plan = (steps: { seq: number; tool: string; state: string }[]) =>
      emit(api.db.db, c, { kind: "plan", payload: { steps } });
    await plan([{ seq: 1, tool: "memory_search", state: "running" }]);
    await deliverNow(c.id);
    let session = await sessionOf(stage.linear, sessionId);
    expect(session.plan).toEqual([
      { content: "Run memory_search", status: "inProgress" },
    ]);
    await plan([
      { seq: 1, tool: "memory_search", state: "done" },
      { seq: 2, tool: "mcp_exec", state: "error" },
    ]);
    await deliverNow(c.id);
    // Delivering the same plan again adds no action.
    await plan([
      { seq: 1, tool: "memory_search", state: "done" },
      { seq: 2, tool: "mcp_exec", state: "error" },
    ]);
    await deliverNow(c.id);
    session = await sessionOf(stage.linear, sessionId);
    expect(session.plan).toEqual([
      { content: "Run memory_search", status: "completed" },
      { content: "Run mcp_exec", status: "canceled" },
    ]);
    const nodes = session.activities.nodes;
    const status = nodes.find((n) => n.content.body === "Searching memory…");
    expect(status?.ephemeral).toBe(true);
    const actions = nodes.filter(
      (n) => n.content.__typename === "AgentActivityActionContent",
    );
    expect(
      actions.map((a) => [
        a.content.action,
        a.content.parameter,
        a.content.result,
      ]),
    ).toEqual([
      ["Ran", "memory_search", "done"],
      ["Failed", "mcp_exec", "failed"],
    ]);
  });

  // Coverage: `linear.in.ack-clock`.
  test("the acknowledgement lands within Linear's ten seconds while the model is still thinking", async () => {
    stage.models.play([{ hang: true }, reply("Late.")]);
    const started = Date.now();
    const issue = await createIssue(stage.linear);
    await delegate(stage, issue.id);
    await drainQueue("ingress");
    const conversation = await newestConversation();
    const running = startTick(conversation.id);
    await untilRequests(stage, 1);
    await drainQueue("outbox");
    const session = await sessionOf(
      stage.linear,
      String(conversation.externalConversationKey),
    );
    expect(session.activities.nodes[0]?.content.__typename).toBe(
      "AgentActivityThoughtContent",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    stage.models.release();
    await running;
    await settle();
  });

  // Coverage: `linear.out.error`.
  test("a failed task is an error activity", async () => {
    stage.models.play([
      { toolCalls: [{ name: "fail", input: { reason: "No cake here." } }] },
    ]);
    const { sessionId } = await opened();
    await settle();
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.status).toBe("error");
    expect(session.activities.nodes.at(-1)?.content.__typename).toBe(
      "AgentActivityErrorContent",
    );
  });
});

describe("questions and approvals", () => {
  // Coverage: `linear.out.elicitation`, `linear.in.prompted`, `linear.out.nothing-after-elicitation`.
  test("a question is an elicitation with options; nothing follows it; the person's prompt answers it", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: {
              question: "Where should I look?",
              options: ["Kitchen", "Garden"],
            },
          },
        ],
      },
      reply("Looking in the garden.", { lastMessageIncludes: "Garden" }),
    ]);
    const { conversation, sessionId } = await opened();
    await settle();
    let session = await sessionOf(stage.linear, sessionId);
    expect(session.status).toBe("awaitingInput");
    const ask = session.activities.nodes.at(-1);
    expect(ask?.content.__typename).toBe("AgentActivityElicitationContent");
    expect(ask?.signal).toBe("select");
    expect(ask?.signalMetadata).toEqual({
      options: [{ value: "Kitchen" }, { value: "Garden" }],
    });
    // While it waits on the answer, nothing is written: not a status, not a plan.
    const waiting = await conversationRow(conversation.id);
    expect(await emitStatus(api.db.db, waiting, "Still here")).toBeNull();
    await deliverNow(conversation.id);
    session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.__typename).toBe(
      "AgentActivityElicitationContent",
    );

    await prompt(sessionId, "Garden");
    await settle();
    session = await sessionOf(stage.linear, sessionId);
    expect(session.status).toBe("complete");
    expect(session.activities.nodes.at(-1)?.content.body).toBe(
      "Looking in the garden.",
    );
  });

  // Coverage: `linear.out.approval`, `linear.in.approval-option`.
  test("an approval is an elicitation; choosing Approve decides it as the participant; the dashboard policy shows only the link", async () => {
    stage.models.play([
      { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: { name: "mail/send_email", args: { to: "toad" } },
          },
        ],
      },
      reply("Sent."),
    ]);
    const { conversation, sessionId } = await opened();
    await api.db.db
      .update(channelBindings)
      .set({ approvalPolicy: "participants" })
      .where(eq(channelBindings.botId, stage.botId));
    await settle();
    const [approval] = await api.db.db
      .select()
      .from(approvals)
      .where(eq(approvals.conversationId, conversation.id));
    let session = await sessionOf(stage.linear, sessionId);
    const card = session.activities.nodes.at(-1);
    expect(card?.content.__typename).toBe("AgentActivityElicitationContent");
    expect(card?.content.body).toContain("mail/send_email");
    expect(card?.content.body).toContain(`/approvals/${approval.id}`);
    expect(card?.signalMetadata).toEqual({
      options: [
        { value: `Approve #${approval.id}` },
        { value: `Deny #${approval.id}` },
      ],
    });
    await prompt(sessionId, `Approve #${approval.id}`);
    await settle();
    const [decided] = await api.db.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(["approved", "consumed"]).toContain(decided.status);
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "approval:decide"),
          eq(auditLogs.actorType, "participant"),
        ),
      );
    expect(audit.metadata).toMatchObject({
      via: "linear",
      decision: "approve",
    });
    session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toBe("Sent.");

    // Under the dashboard policy: no options, only the link.
    await api.db.db
      .update(channelBindings)
      .set({ approvalPolicy: "dashboard" })
      .where(eq(channelBindings.botId, stage.botId));
    stage.models.play([
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: { name: "mail/send_email", args: { to: "peach" } },
          },
        ],
      },
    ]);
    await prompt(sessionId, "And Peach");
    await settle();
    session = await sessionOf(stage.linear, sessionId);
    const linkOnly = session.activities.nodes.at(-1);
    expect(linkOnly?.content.__typename).toBe(
      "AgentActivityElicitationContent",
    );
    expect(linkOnly?.signal).toBeNull();
    expect(linkOnly?.content.body).toContain("/approvals/");
  });

  // Coverage: `linear.tool.comment`, `linear.tool.issue-view`.
  test("the Linear tools read this session's issue and comment on it only after an approval", async () => {
    stage.models.play([
      {
        toolCalls: [{ name: "linear_issue_view", input: {} }],
      },
      {
        expect: { lastMessageIncludes: "Someone hid the cake." },
        toolCalls: [
          {
            name: "linear_comment_create",
            input: { body: "Checked the kitchen." },
          },
        ],
      },
      reply("Commented."),
    ]);
    const { issue, conversation, sessionId } = await opened();
    await settle();
    const [approval] = await api.db.db
      .select()
      .from(approvals)
      .where(eq(approvals.conversationId, conversation.id));
    expect([approval.server, approval.tool]).toEqual([
      "linear",
      "comment_create",
    ]);
    expect(
      stage.linear.requests().filter((r) => r.operation === "CommentCreate"),
    ).toHaveLength(0);
    const decided = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approval.id}`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(200);
    await settle();
    const comment = stage.linear
      .requests()
      .find((r) => r.operation === "CommentCreate");
    expect(comment?.variables).toEqual({
      input: { issueId: issue.id, body: "Checked the kitchen." },
    });
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toBe("Commented.");
  });
});

describe("stop and disengagement", () => {
  /**
   * Open a session the bot is waiting in (it asked a question).
   * @returns The session.
   */
  async function waitingSession(input: Record<string, unknown> = {}) {
    stage.models.play([
      {
        toolCalls: [
          { name: "ask_question", input: { question: "Which room?" } },
        ],
      },
    ]);
    const s = await opened(input);
    await settle();
    expect((await conversationRow(s.conversation.id)).state).toBe("waiting");
    return s;
  }

  /** Whether a conversation was cancelled, and its outbox got nothing new. */
  async function expectDisengaged(conversationId: number, before: number) {
    await settle();
    const c = await conversationRow(conversationId);
    expect(c.state).toBe("ended");
    expect(c.outcome).toBe("cancelled");
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, conversationId));
    expect(rows.length).toBe(before);
  }

  /** How many outbox rows a conversation has. */
  async function outboxCount(conversationId: number) {
    return (
      await api.db.db
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.conversationId, conversationId))
    ).length;
  }

  // Coverage: `linear.in.stop`.
  test("Stop cancels the turn and is answered once, quoting the person's note without acting on it", async () => {
    const { conversation, sessionId } = await waitingSession();
    await stage.linear.control("/__test/agents/stop", {
      sessionId,
      body: "Delete the repo instead",
    });
    await stage.linear.drain();
    await settle();
    expect((await lastEvent()).outcome).toBe("signal");
    const c = await conversationRow(conversation.id);
    expect(c.outcome).toBe("cancelled");
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.status).toBe("complete");
    const last = session.activities.nodes.at(-1);
    expect(last?.content.__typename).toBe("AgentActivityResponseContent");
    expect(last?.content.body).toContain("Stopped, as asked.");
    expect(last?.content.body).toContain("Delete the repo instead");
    expect(stage.models.requests).toHaveLength(1);
  });

  // Coverage: `linear.in.undelegate`, `linear.in.re-engage`.
  test("un-delegation disengages silently; the person's next prompt re-engages", async () => {
    const { issue, conversation, sessionId } = await waitingSession();
    const before = await outboxCount(conversation.id);
    await updateIssue(stage.linear, issue.id, { delegateId: null });
    await flow(stage);
    await expectDisengaged(conversation.id, before);
    expect((await lastEvent()).outcome).toBe("lifecycle");

    stage.models.play([reply("Back on it.")]);
    await prompt(sessionId, "Please carry on");
    await settle();
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toBe("Back on it.");
  });

  // Coverage: `linear.in.issue-completed`.
  test("a person completing the issue disengages it", async () => {
    const { issue, conversation } = await waitingSession();
    const before = await outboxCount(conversation.id);
    await updateIssue(stage.linear, issue.id, {
      stateId: FINEAR.primary.completed,
    });
    await flow(stage);
    await expectDisengaged(conversation.id, before);
  });

  // Coverage: `linear.in.issue-removed`, `linear.in.unassigned`.
  test("a deleted issue and an unassignment notification disengage", async () => {
    const one = await waitingSession();
    const beforeOne = await outboxCount(one.conversation.id);
    const removed = await inject(stage.app, {
      type: "Issue",
      action: "remove",
      organizationId: FINEAR.primary.organization,
      createdAt: new Date().toISOString(),
      data: { id: one.issue.id },
    });
    expect(removed.status).toBe(200);
    await expectDisengaged(one.conversation.id, beforeOne);

    const two = await waitingSession();
    const beforeTwo = await outboxCount(two.conversation.id);
    await inject(stage.app, {
      type: "AppUserNotification",
      action: "issueUnassignedFromYou",
      organizationId: FINEAR.primary.organization,
      appUserId: stage.app.appUserId,
      createdAt: new Date().toISOString(),
      notification: {
        id: crypto.randomUUID(),
        type: "issueUnassignedFromYou",
        issueId: two.issue.id,
      },
    });
    await expectDisengaged(two.conversation.id, beforeTwo);
  });

  // Coverage: `linear.in.permission-change`.
  test("losing a team disengages its sessions and records the team access", async () => {
    const { conversation } = await waitingSession();
    const before = await outboxCount(conversation.id);
    await inject(stage.app, {
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: FINEAR.primary.organization,
      appUserId: stage.app.appUserId,
      createdAt: new Date().toISOString(),
      canAccessAllPublicTeams: false,
      addedTeamIds: [],
      removedTeamIds: [FINEAR.primary.team],
    });
    await expectDisengaged(conversation.id, before);
    const [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.app.installationId));
    expect(row.config.teamAccess).toEqual({
      canAccessAllPublicTeams: false,
      teamIds: [],
    });
  });

  // Coverage: `linear.in.notification`.
  test("notifications never start work; each has a decided outcome", async () => {
    for (const [type, outcome] of [
      ["issueAssignedToYou", "assigned-not-delegated"],
      ["issueMention", "notification-issueMention"],
      ["issueNewComment", "notification-issueNewComment"],
    ]) {
      await inject(stage.app, {
        type: "AppUserNotification",
        action: type,
        organizationId: FINEAR.primary.organization,
        appUserId: stage.app.appUserId,
        createdAt: new Date().toISOString(),
        notification: { id: crypto.randomUUID(), type, issueId: "x" },
      });
      await drainQueue("ingress");
      const event = await lastEvent();
      expect([event.status, event.outcome]).toEqual(["ignored", outcome]);
    }
    expect(await newestConversation()).toBeUndefined();
  });

  // Coverage: `linear.in.oauth-revoked`.
  test("revocation uninstalls silently and forgets the tokens; the app is installed again by OAuth", async () => {
    const { conversation } = await waitingSession();
    const before = await outboxCount(conversation.id);
    await inject(stage.app, {
      type: "OAuthApp",
      action: "revoked",
      organizationId: FINEAR.primary.organization,
      oauthClientId: stage.app.clientId,
      createdAt: new Date().toISOString(),
    });
    await expectDisengaged(conversation.id, before);
    const { openInstallation } = await import("../../ops/InstallationOps");
    let [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.app.installationId));
    expect(row.status).toBe("uninstalled");
    expect(Object.keys(openInstallation(row).credentials).sort()).toEqual([
      "clientSecret",
      "webhookSecret",
    ]);
    // A delivery to an uninstalled app is still answered 200, and dropped.
    const events = (await api.db.db.select().from(outboxMessages)).length;
    const late = await inject(stage.app, {
      type: "Issue",
      action: "update",
      organizationId: FINEAR.primary.organization,
      createdAt: new Date().toISOString(),
      data: { id: "y" },
    });
    expect(late.status).toBe(200);
    expect((await api.db.db.select().from(outboxMessages)).length).toBe(events);

    const landed = await completeLinearInstall(
      stage,
      stage.linear,
      stage.app.installationId,
    );
    expect(landed).toContain("installed=linear");
    [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.app.installationId));
    expect(row.status).toBe("active");
  });
});

describe("memory and channels", () => {
  // Coverage: `linear.channel.project`, `linear.memory.boundary`.
  test("a project's issues share channel memory; another project's and a team's do not", async () => {
    const P = await createProject(stage.linear, "Cake hunt");
    const Q = await createProject(stage.linear, "Pie hunt");
    stage.models.play([
      {
        toolCalls: [
          {
            name: "memory_write",
            input: {
              path: "cake.md",
              scope: "channel",
              content: "The cake is in the garden shed.",
              changeNote: "Found it",
            },
          },
        ],
      },
      reply("Noted."),
    ]);
    const first = await opened({ projectId: P });
    await settle();
    const search = (expectation: Record<string, string>) => [
      {
        toolCalls: [
          { name: "memory_search", input: { query: "cake garden shed" } },
        ],
      },
      { ...reply("Done."), expect: expectation },
    ];
    stage.models.play(search({ lastMessageIncludes: "garden shed" }));
    const second = await opened({ projectId: P });
    await settle();
    expect(second.conversation.channelId).toBe(first.conversation.channelId);

    stage.models.play(search({}));
    const other = await opened({ projectId: Q });
    await settle();
    expect(other.conversation.channelId).not.toBe(first.conversation.channelId);
    const results = await api.db.db
      .select()
      .from(conversationEntries)
      .where(
        and(
          eq(conversationEntries.conversationId, other.conversation.id),
          eq(conversationEntries.kind, "tool_result"),
        ),
      );
    expect(JSON.stringify(results.map((r) => r.content))).not.toContain(
      "garden shed",
    );
    const [channel] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.id, first.conversation.channelId));
    expect(channel.externalId).toBe(
      `${FINEAR.primary.organization}/project:${P}`,
    );
  });

  // Coverage: `linear.channel.moved`.
  test("an issue moved to another project keeps its session's conversation and memory boundary", async () => {
    stage.models.play([reply("First."), reply("Second.")]);
    const { issue, conversation, sessionId } = await opened({
      projectId: await createProject(stage.linear, "Before"),
    });
    await settle();
    await updateIssue(stage.linear, issue.id, {
      projectId: await createProject(stage.linear, "After"),
    });
    await prompt(sessionId, "Again");
    await settle();
    const again = await conversationForSession(sessionId);
    expect(again.id).toBe(conversation.id);
    expect(again.channelId).toBe(conversation.channelId);
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toBe("Second.");
  });
});

describe("what the bot writes", () => {
  // Coverage: `linear.out.mention-safe`.
  test("no outbound text carries a literal mention of the bot", async () => {
    const [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.app.installationId));
    const name = String(row.config.appUserName);
    expect(name.length).toBeGreaterThan(1);
    stage.models.play([
      reply(`Ask @${name} or @${name.replace(/\s+/g, "")} again.`),
    ]);
    const { sessionId } = await opened();
    await settle();
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toContain(`@​${name}`);
    const literal = new RegExp(
      `@(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "i",
    );
    for (const r of stage.linear.requests()) {
      if (r.operation !== "AgentActivityCreate") continue;
      expect(JSON.stringify(r.variables)).not.toMatch(literal);
    }
  });

  // Coverage: `linear.out.ratelimited`.
  test("RATELIMITED reschedules the row until Linear's reset; it is sent once the wait is over", async () => {
    stage.models.play([reply("Eventually.")]);
    stage.linear.fault({
      kind: "ratelimit",
      match: (r) =>
        r.operation === "AgentActivityCreate" &&
        JSON.stringify(r.variables).includes("Eventually."),
      resetAt: Date.now() + 30_000,
    });
    const { conversation, sessionId } = await opened();
    await settle();
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          eq(outboxMessages.kind, "message"),
        ),
      );
    expect(row.status).toBe("failed");
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(20_000);
    await api.db.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(outboxMessages.id, row.id));
    await deliverNow(conversation.id);
    const session = await sessionOf(stage.linear, sessionId);
    expect(session.activities.nodes.at(-1)?.content.body).toBe("Eventually.");
  });

  // Coverage: `linear.out.retry-idempotent`.
  test("an activity whose answer was lost is sent again with the same id, and lands once", async () => {
    stage.models.play([reply("Once.")]);
    stage.linear.fault({
      kind: "drop",
      match: (r) =>
        r.operation === "AgentActivityCreate" &&
        JSON.stringify(r.variables).includes("Once."),
    });
    const { conversation, sessionId } = await opened();
    await settle();
    await api.db.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(outboxMessages.conversationId, conversation.id));
    await deliverNow(conversation.id);
    const session = await sessionOf(stage.linear, sessionId);
    expect(
      session.activities.nodes.filter((n) => n.content.body === "Once."),
    ).toHaveLength(1);
    const [row] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          eq(outboxMessages.kind, "message"),
        ),
      );
    expect(row.status).toBe("sent");
  });

  // Coverage: `linear.out.bucket`.
  test("the token bucket's reserve keeps acknowledgements flowing when it is nearly empty", async () => {
    const saved = { ...config.platforms.linear };
    config.platforms.linear.bucketCapacity = 2;
    config.platforms.linear.bucketReserve = 2;
    config.platforms.linear.bucketRefillPerSecond = 0.01;
    try {
      stage.models.play([reply("Waits.")]);
      const { conversation, sessionId } = await opened();
      // The acknowledgement took a reserved token.
      let session = await sessionOf(stage.linear, sessionId);
      expect(session.activities.nodes).toHaveLength(1);
      await settle();
      const [row] = await api.db.db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.conversationId, conversation.id),
            eq(outboxMessages.kind, "message"),
          ),
        );
      expect(row.status).toBe("failed");
      session = await sessionOf(stage.linear, sessionId);
      expect(session.activities.nodes.map((n) => n.content.body)).not.toContain(
        "Waits.",
      );
    } finally {
      Object.assign(config.platforms.linear, saved);
    }
  });
});
