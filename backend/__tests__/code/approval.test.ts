import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { api } from "keryx";
import { callKey } from "../../ops/ApprovalPatternOps";
import { approvals } from "../../schema/approvals";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { notifications } from "../../schema/notifications";
import { conversationRow, runTicks, startConversation } from "../agent/harness";
import {
  addServer,
  approvalsOf,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  type McpStage,
  replyStep,
  resultsOf,
} from "../mcp/harness";
import { HOOK_TIMEOUT } from "../setup";
import { codeRunsOf, codeStep, decide, SEND_TWO } from "./harness";

/**
 * Approvals inside a program: a gated call interrupts before its effect;
 * concurrent gated calls interrupt together and wait as one batch; approving
 * the whole batch resumes the same program, which replays its settled calls
 * from the continuation and runs each approved call exactly once; the
 * program's result is written once.
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

test("one ungated call and two concurrent gated ones: a batch of two, each sent exactly once after both are approved", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/read_inbox"] });
  stage.models.play([codeStep(SEND_TWO)]);
  const id = (await startConversation(stage, "Tell everyone the cake is ready"))
    .body.conversation.id;
  await runTicks();

  // The ungated call ran once; the gated ones not at all.
  expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);
  const row = await conversationRow(id);
  expect(row.state).toBe("waiting");
  const batch = await approvalsOf(id);
  expect(batch).toHaveLength(2);
  const [run] = await codeRunsOf(id);
  expect(run.status).toBe("interrupted");
  expect(run.continuation).not.toBeNull();
  expect(row.waitingOn).toEqual({
    kind: "approval",
    approvalIds: batch.map((a) => a.id),
  });
  for (const a of batch) {
    expect(a.codeRunId).toBe(run.id);
    expect(a.entryId).toBe(run.entryId);
    expect(run.interruptionIds).toContain(String(a.interruptionId));
    expect(a.status).toBe("pending");
  }
  expect(batch.map((a) => a.callKey).sort()).toEqual(
    [
      callKey("mail", "send_email", { to: "toad", subject: "cake" }),
      callKey("mail", "send_email", { to: "peach", subject: "cake" }),
    ].sort(),
  );
  // The intent is open: the program has no result yet.
  expect(await resultsOf(id, "run_code")).toEqual([]);

  // Deciding one leaves the conversation waiting on the other.
  expect((await decide(stage, batch[0].id, "approve")).status).toBe(200);
  await runTicks();
  expect((await conversationRow(id)).state).toBe("waiting");
  expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);

  // Approve the second: the program resumes and finishes.
  stage.models.play([
    {
      ...replyStep("Both sent."),
      expect: { lastMessageIncludes: "sent to peach" },
    },
  ]);
  expect((await decide(stage, batch[1].id, "approve")).status).toBe(200);
  await runTicks();

  expect((await conversationRow(id)).state).toBe("hibernating");
  // The ungated call was replayed from the continuation, not sent again.
  expect(stage.fixture.calls.map((c) => c.tool).sort()).toEqual([
    "read_inbox",
    "send_email",
    "send_email",
  ]);
  expect(
    stage.fixture.calls
      .filter((c) => c.tool === "send_email")
      .map((c) => c.args.to)
      .sort(),
  ).toEqual(["peach", "toad"]);
  const results = await resultsOf(id, "run_code");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    codeRunId: run.id,
    resultType: "object",
    result: {
      inbox: "1. From Toad: the cake is ready",
      sent: ["sent to toad", "sent to peach"],
    },
  });
  for (const a of await approvalsOf(id)) {
    expect(a.status).toBe("consumed");
    expect(a.executingAt).not.toBeNull();
  }
  const [done] = await codeRunsOf(id);
  expect(done.status).toBe("completed");
  expect(done.continuation).toBeNull();
  expect(done.invocations).toBe(2);
  const sends = done.hostCalls.filter((h) => h.fn === "mcp.exec");
  expect(sends.map((h) => h.gate).sort()).toEqual([
    "allowed",
    "approved",
    "approved",
  ]);

  // Another tick sends nothing more.
  await runTicks();
  expect(stage.fixture.calls).toHaveLength(3);
});

test("an allowlisted program never waits, and mcp.info satisfies info-before-exec", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  stage.models.play([codeStep(SEND_TWO), replyStep()]);
  const id = (await startConversation(stage, "Send them")).body.conversation.id;
  await runTicks();
  expect((await conversationRow(id)).state).toBe("hibernating");
  expect(await approvalsOf(id)).toEqual([]);
  expect(stage.fixture.calls).toHaveLength(3);
});

test("a gated call in a program parks the step's terminal call, as a direct one does", async () => {
  await bindServer(stage, serverId);
  stage.models.play([
    {
      toolCalls: [
        {
          name: "run_code",
          input: {
            source:
              'await mcp.info("mail", "send_email"); return await mcp.exec("mail", "send_email", { to: "toad", subject: "x" })',
          },
        },
        { name: "reply_and_wait", input: { text: "Sent." } },
      ],
    },
  ]);
  const id = (await startConversation(stage, "Send it")).body.conversation.id;
  await runTicks();
  expect((await conversationRow(id)).state).toBe("waiting");
  expect(await resultsOf(id, "reply_and_wait")).toEqual([
    expect.objectContaining({ error_type: "not_run" }),
  ]);
  expect(stage.fixture.calls).toEqual([]);
});
