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
import { outcomeOfApproval } from "../../ops/ApprovalOps";
import {
  allowance,
  callKey,
  canonicalJson,
  matchPattern,
  patternProblem,
} from "../../ops/ApprovalPatternOps";
import { approvals } from "../../schema/approvals";
import { auditLogs } from "../../schema/audit_logs";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { notifications } from "../../schema/notifications";
import {
  conversationRow,
  runTicks,
  shape,
  startConversation,
} from "../agent/harness";
import { call, createTag, HOOK_TIMEOUT, runAction } from "../setup";
import {
  addServer,
  approvalsOf,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  infoThenExec,
  type McpStage,
  replyStep,
  resultsOf,
} from "./harness";

/**
 * The approval gate, end to end: the decision table, a step whose calls are
 * part gated and part not, resuming the same intent without replay, deny,
 * expiry, always-allow under one audit row, who may decide, and that an
 * approval runs exactly the call it names.
 */
let stage: McpStage;
let serverId: number;

beforeAll(async () => {
  stage = await buildMcpStage();
  serverId = (await addServer(stage)).id;
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  stage.fixture.reset();
  await api.db.db.delete(botMcpServers);
  await api.db.db.delete(approvals);
  await api.db.db.delete(notifications);
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Decide an approval over HTTP.
 * @param id - The approval.
 * @param body - The decision.
 * @param user - Who decides.
 * @returns The response.
 */
function decide(
  id: number,
  body: Record<string, unknown>,
  user = stage.u.peach,
) {
  return call<{ approval: Record<string, unknown> }>(
    stage.u.url,
    user,
    "POST",
    `/project/${stage.u.projectId}/approval/${id}`,
    body,
  );
}

/**
 * Start a conversation that sends an email, and run it until it parks.
 * @returns The conversation id.
 */
async function parkOnSend(): Promise<number> {
  stage.models.play([
    ...infoThenExec("mail/send_email", { to: "toad", subject: "hi" }),
  ]);
  const started = await startConversation(stage, "Email Toad");
  const id = started.body.conversation.id;
  await runTicks();
  return id;
}

describe("patterns and the decision table's first columns", () => {
  test("every pattern form", () => {
    expect(matchPattern("mail/send_email", "mail", "send_email")).toBe(true);
    expect(matchPattern("mail/*", "mail", "send_email")).toBe(true);
    expect(matchPattern("*/send_email", "other", "send_email")).toBe(true);
    expect(matchPattern("send_email", "other", "send_email")).toBe(true);
    expect(matchPattern("/^mail\\/read_/", "mail", "read_inbox")).toBe(true);
    expect(matchPattern("/^mail\\/read_/", "mail", "send_email")).toBe(false);
    expect(matchPattern("mail/read_inbox", "mail", "send_email")).toBe(false);
    expect(matchPattern("other/*", "mail", "send_email")).toBe(false);
    expect(patternProblem("a/b/c")).not.toBeNull();
    expect(patternProblem("/[/")).not.toBeNull();
    expect(patternProblem("mail/*")).toBeNull();
  });

  test("allowlisted; read-only with autoAllowReadOnly; read-only without it; neither", () => {
    const ro = { name: "read_inbox", annotations: { readOnlyHint: true } };
    const rw = { name: "send_email", annotations: {} };
    expect(
      allowance(
        { allowedTools: ["mail/*"], autoAllowReadOnly: false },
        "mail",
        rw,
      ).allowed,
    ).toBe(true);
    expect(
      allowance({ allowedTools: [], autoAllowReadOnly: true }, "mail", ro)
        .allowed,
    ).toBe(true);
    expect(
      allowance({ allowedTools: [], autoAllowReadOnly: false }, "mail", ro)
        .allowed,
    ).toBe(false);
    expect(
      allowance({ allowedTools: [], autoAllowReadOnly: true }, "mail", rw)
        .allowed,
    ).toBe(false);
  });

  test("the call key ignores key order and binds server, tool, and arguments", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    const k = callKey("mail", "send_email", { to: "toad", subject: "hi" });
    expect(callKey("mail", "send_email", { subject: "hi", to: "toad" })).toBe(
      k,
    );
    expect(
      callKey("mail", "send_email", { to: "bowser", subject: "hi" }),
    ).not.toBe(k);
    expect(
      callKey("mail", "read_inbox", { to: "toad", subject: "hi" }),
    ).not.toBe(k);
  });
});

describe("the gate in a conversation", () => {
  test("an allowlisted call runs at once", async () => {
    await bindServer(stage, serverId, { allowedTools: ["mail/send_email"] });
    stage.models.play([
      ...infoThenExec("mail/send_email", { to: "toad", subject: "hi" }),
      replyStep(),
    ]);
    const id = (await startConversation(stage, "Email Toad")).body.conversation
      .id;
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["send_email"]);
    expect(await approvalsOf(id)).toEqual([]);
  });

  test("a read-only call runs when autoAllowReadOnly is on, and waits when it is off", async () => {
    await bindServer(stage, serverId, { autoAllowReadOnly: true });
    stage.models.play([...infoThenExec("mail/read_inbox"), replyStep()]);
    const a = (await startConversation(stage, "Inbox?")).body.conversation.id;
    await runTicks();
    expect((await conversationRow(a)).state).toBe("hibernating");
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);

    await bindServer(stage, serverId, { autoAllowReadOnly: false });
    stage.fixture.reset();
    stage.models.play(infoThenExec("mail/read_inbox"));
    const b = (await startConversation(stage, "Inbox again?")).body.conversation
      .id;
    await runTicks();
    expect((await conversationRow(b)).state).toBe("waiting");
    expect(stage.fixture.calls).toEqual([]);
  });

  test("default deny: a gated call parks the conversation on an approval, notifies, and sends nothing", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const row = await conversationRow(id);
    expect(row.state).toBe("waiting");
    const [approval] = await approvalsOf(id);
    expect(row.waitingOn).toEqual({
      kind: "approval",
      approvalIds: [approval.id],
    });
    expect(approval).toMatchObject({
      status: "pending",
      server: "mail",
      tool: "send_email",
      args: { to: "toad", subject: "hi" },
      callKey: callKey("mail", "send_email", { to: "toad", subject: "hi" }),
      requestedByUserId: stage.u.peach.userId,
    });
    expect(stage.fixture.calls).toEqual([]);
    const notes = await api.db.db
      .select()
      .from(notifications)
      .where(eq(notifications.template, "approval-requested"));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].linkPath).toBe(`/approvals/${approval.id}`);
    // The intent is open: no result was written for it.
    expect(await resultsOf(id, "mcp_exec")).toEqual([]);
  });

  test("approve resumes the same intent without replaying any step, and the fixture records exactly one call", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const before = await shape(id);
    const [approval] = await approvalsOf(id);
    const requestsBefore = stage.models.completions.length;

    stage.models.play([
      {
        ...replyStep("Sent."),
        expect: { lastMessageIncludes: "sent to toad" },
      },
    ]);
    const res = await decide(approval.id, {
      decision: "approve",
      via: "dashboard",
    });
    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe("approved");
    await runTicks();

    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["send_email"]);
    const after = await shape(id);
    // Nothing before the wait is replayed: the old entries are a prefix.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      "status_change:waiting→working",
      "tool_result:mcp_exec",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    // One model request after the decision: the reply.
    expect(stage.models.completions.length).toBe(requestsBefore + 1);
    const [consumed] = await approvalsOf(id);
    expect(consumed.status).toBe("consumed");
    expect(consumed.executingAt).not.toBeNull();
    expect(consumed.decidedVia).toBe("dashboard");

    // A second decision is refused; a second tick sends nothing.
    expect((await decide(approval.id, { decision: "approve" })).status).toBe(
      406,
    );
    await runTicks();
    expect(stage.fixture.calls.length).toBe(1);
  });

  test("a step with one gated and one ungated call: the ungated one runs, then the conversation waits", async () => {
    await bindServer(stage, serverId, { allowedTools: ["mail/read_inbox"] });
    stage.models.play([
      {
        toolCalls: [
          { name: "mcp_info", input: { name: "mail/read_inbox" } },
          { name: "mcp_info", input: { name: "mail/send_email" } },
        ],
      },
      {
        toolCalls: [
          { name: "mcp_exec", input: { name: "mail/read_inbox", args: {} } },
          {
            name: "mcp_exec",
            input: {
              name: "mail/send_email",
              args: { to: "toad", subject: "x" },
            },
          },
          { name: "reply_and_wait", input: { text: "Both done." } },
        ],
      },
    ]);
    const id = (await startConversation(stage, "Read and send")).body
      .conversation.id;
    await runTicks();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);
    expect((await conversationRow(id)).state).toBe("waiting");
    const replies = await resultsOf(id, "reply_and_wait");
    expect(replies).toEqual([
      expect.objectContaining({ error_type: "not_run" }),
    ]);

    const [approval] = await approvalsOf(id);
    stage.models.play([replyStep("Both done.")]);
    await decide(approval.id, { decision: "approve" });
    await runTicks();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual([
      "read_inbox",
      "send_email",
    ]);
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("deny gives an error result the model's next request contains, and nothing is sent", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const [approval] = await approvalsOf(id);
    stage.models.play([
      {
        ...replyStep("I won't send it."),
        expect: { lastMessageIncludes: "Do not retry" },
      },
    ]);
    const res = await decide(approval.id, {
      decision: "deny",
      note: "ask Toad in person",
    });
    expect(res.body.approval.status).toBe("denied");
    await runTicks();
    expect(stage.fixture.calls).toEqual([]);
    const [result] = await resultsOf(id, "mcp_exec");
    expect(result).toMatchObject({ is_error: true, error_type: "denied" });
    expect(String(result.message)).toContain("Peach");
    expect(String(result.message)).toContain("ask Toad in person");
    expect((await approvalsOf(id))[0].status).toBe("denied");
  });

  test("expiry: approvals:expire expires it, wakes the conversation, and the model reads a denial", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const [approval] = await approvalsOf(id);
    await api.db.db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, approval.id));
    stage.models.play([
      {
        ...replyStep("Nobody answered."),
        expect: { lastMessageIncludes: "expired" },
      },
    ]);
    const out = await runAction<{ expired: number }>("approvals:expire", {});
    expect(out.expired).toBe(1);
    expect((await conversationRow(id)).state).toBe("working");
    await runTicks();
    expect((await approvalsOf(id))[0].status).toBe("expired");
    expect(stage.fixture.calls).toEqual([]);
    expect((await conversationRow(id)).state).toBe("hibernating");
    // Deciding it now is refused.
    expect((await decide(approval.id, { decision: "approve" })).status).toBe(
      406,
    );
  });

  test("always allow approves and appends server/tool to the allowlist, under one audit row", async () => {
    await bindServer(stage, serverId, { allowedTools: ["mail/read_inbox"] });
    const id = await parkOnSend();
    const [approval] = await approvalsOf(id);
    stage.models.play([replyStep()]);
    const res = await decide(approval.id, {
      decision: "approve",
      alwaysAllow: true,
    });
    expect(res.status).toBe(200);
    const [binding] = await api.db.db.select().from(botMcpServers);
    expect(binding.allowedTools).toEqual([
      "mail/read_inbox",
      "mail/send_email",
    ]);
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "approval:decide"))
      .orderBy(auditLogs.id);
    const row = rows[rows.length - 1];
    expect(row.after).toMatchObject({
      approval: { id: approval.id, status: "approved" },
      botMcpServer: { allowedTools: ["mail/read_inbox", "mail/send_email"] },
    });
    expect(row.before).toMatchObject({
      botMcpServer: { allowedTools: ["mail/read_inbox"] },
    });
    await runTicks();
    expect(stage.fixture.calls.length).toBe(1);

    // The next identical call runs without asking.
    stage.models.play([
      ...infoThenExec("mail/send_email", { to: "luigi", subject: "x" }),
      replyStep(),
    ]);
    const next = (await startConversation(stage, "Again")).body.conversation.id;
    await runTicks();
    expect(await approvalsOf(next)).toEqual([]);
    expect(stage.fixture.calls.length).toBe(2);
  });

  test("an approval cannot run a different call: a tampered call key is refused and nothing is sent", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const [approval] = await approvalsOf(id);
    expect(
      await outcomeOfApproval(api.db.db, approval, "a-different-key"),
    ).toMatchObject({
      kind: "refuse",
      output: { error_type: "approval_mismatch" },
    });

    // The row now names other arguments than the intent it is bound to.
    await api.db.db
      .update(approvals)
      .set({
        callKey: callKey("mail", "send_email", { to: "bowser", subject: "hi" }),
      })
      .where(eq(approvals.id, approval.id));
    stage.models.play([replyStep()]);
    await decide(approval.id, { decision: "approve" });
    await runTicks();
    expect(stage.fixture.calls).toEqual([]);
    const [result] = await resultsOf(id, "mcp_exec");
    expect(result).toMatchObject({ error_type: "approval_mismatch" });
  });

  test("waiting (approval) × inbound message: kept in the inbox, delivered when the wait ends", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const sent = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${id}/message`,
      { text: "also say hello" },
    );
    expect(sent.status).toBe(200);
    expect((await conversationRow(id)).state).toBe("waiting");
    const [approval] = await approvalsOf(id);
    stage.models.play([
      { ...replyStep(), expect: { anyMessageIncludes: "also say hello" } },
    ]);
    await decide(approval.id, { decision: "approve" });
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
    expect(stage.fixture.calls.length).toBe(1);
  });

  test("cancelling a conversation expires its pending approvals", async () => {
    await bindServer(stage, serverId);
    const id = await parkOnSend();
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/conversation/${id}/cancel`,
      {},
    );
    expect(res.status).toBe(200);
    expect((await approvalsOf(id))[0].status).toBe("expired");
  });
});

describe("who may decide", () => {
  test("a member without the bot's write access cannot; its approver tag can; an outsider sees nothing", async () => {
    await bindServer(stage, serverId);
    // Only operators may write Toadsworth.
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: ["operators"] },
    );
    const id = await parkOnSend();
    const [approval] = await approvalsOf(id);

    const toad = await decide(
      approval.id,
      { decision: "approve" },
      stage.u.toad,
    );
    expect(toad.status).toBe(403);
    const bowser = await decide(
      approval.id,
      { decision: "approve" },
      stage.u.bowser,
    );
    expect(bowser.status).toBe(403);

    const list = await call<{
      approvals: { id: number; canDecide: boolean }[];
    }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `/project/${stage.u.projectId}/approvals?status=pending`,
    );
    expect(list.body.approvals).toEqual([
      expect.objectContaining({ id: approval.id, canDecide: false }),
    ]);

    const approversId = await createTag(
      stage.u.url,
      stage.u.peach,
      stage.u.projectId,
      "approvers",
    );
    const tagged = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { approverTag: "approvers", approvalTtlSeconds: 3600 },
    );
    expect(tagged.status).toBe(200);
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/member/${stage.u.toad.userId}/tag/${approversId}`,
      {},
    );
    stage.models.play([replyStep()]);
    const allowed = await decide(
      approval.id,
      { decision: "deny" },
      stage.u.toad,
    );
    expect(allowed.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approval.id)));
    expect(row.decidedByUserId).toBe(stage.u.toad.userId);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: [], approverTag: null },
    );
  });
});
