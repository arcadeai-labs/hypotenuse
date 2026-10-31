import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { api } from "keryx";
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
import { codeRunsOf, codeStep, decide } from "./harness";

/**
 * A denied interruption: the resumed program's gated call throws
 * `approval_denied`, which the program may catch and fall back from; left
 * uncaught, the program fails with that type. Nothing is sent either way.
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
 * Run a program to its first approval, then deny it.
 * @param source - The program.
 * @returns The conversation id.
 */
async function denyFirst(source: string): Promise<number> {
  await bindServer(stage, serverId);
  stage.models.play([codeStep(source)]);
  const id = (await startConversation(stage, "Email Toad")).body.conversation
    .id;
  await runTicks();
  const [approval] = await approvalsOf(id);
  expect(approval.status).toBe("pending");
  stage.models.play([replyStep("Understood.")]);
  await decide(stage, approval.id, "deny", "ask Toad in person");
  await runTicks();
  expect((await conversationRow(id)).state).toBe("hibernating");
  expect(stage.fixture.calls).toEqual([]);
  return id;
}

test("a program that catches approval_denied returns its fallback", async () => {
  const id = await denyFirst(`
    await mcp.info("mail", "send_email");
    try {
      return await mcp.exec("mail", "send_email", { to: "toad", subject: "hi" });
    } catch (e) {
      if (e.code === "approval_denied") return { fallback: true, why: e.message };
      throw e;
    }
  `);
  const [result] = await resultsOf(id, "run_code");
  expect(result).toMatchObject({ result: { fallback: true } });
  expect(String((result.result as { why: string }).why)).toContain(
    "ask Toad in person",
  );
  const [run] = await codeRunsOf(id);
  expect(run.status).toBe("completed");
  expect(run.hostCalls.find((h) => h.fn === "mcp.exec" && !h.ok)).toMatchObject(
    { errorType: "approval_denied", gate: "denied" },
  );
  expect((await approvalsOf(id))[0].status).toBe("denied");
});

test("left uncaught, the denial fails the program as approval_denied, with the short primer", async () => {
  const id = await denyFirst(`
    await mcp.info("mail", "send_email");
    return await mcp.exec("mail", "send_email", { to: "toad", subject: "hi" });
  `);
  const [result] = await resultsOf(id, "run_code");
  expect(result).toMatchObject({
    is_error: true,
    error_type: "approval_denied",
  });
  expect(String(result.next_action_hint)).toContain("run_code primer");
  // A failure says what had already run, as a crash report does.
  expect(
    (result.hostCalls as { fn: string; ok: boolean }[]).map((h) => [
      h.fn,
      h.ok,
    ]),
  ).toEqual([
    ["mcp.info", true],
    ["mcp.exec", false],
  ]);
  expect((await codeRunsOf(id))[0].status).toBe("failed");
});

test("a denial stands even if the allowlist is widened while the program waits", async () => {
  await bindServer(stage, serverId);
  stage.models.play([
    codeStep(`
      await mcp.info("mail", "send_email");
      return await mcp.exec("mail", "send_email", { to: "toad", subject: "hi" });
    `),
  ]);
  const id = (await startConversation(stage, "Email Toad")).body.conversation
    .id;
  await runTicks();
  const [approval] = await approvalsOf(id);
  // Someone allowlists the tool, and someone else denies this call.
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  stage.models.play([replyStep("Not sent.")]);
  await decide(stage, approval.id, "deny");
  await runTicks();
  expect(stage.fixture.calls).toEqual([]);
  const [result] = await resultsOf(id, "run_code");
  expect(result).toMatchObject({ error_type: "approval_denied" });
});
