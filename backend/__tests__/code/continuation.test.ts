import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { encryptBytes } from "../../ops/CryptoOps";
import {
  openContinuation,
  sealContinuation,
} from "../../ops/code/continuation";
import { approvals } from "../../schema/approvals";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { codeRuns } from "../../schema/code_runs";
import { conversationEntries } from "../../schema/conversation_entries";
import { notifications } from "../../schema/notifications";
import { projects } from "../../schema/projects";
import { runTicks, startConversation } from "../agent/harness";
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
import { call, HOOK_TIMEOUT } from "../setup";
import { codeRunsOf, codeStep, decide } from "./harness";

/**
 * A resumed program is the same program, or it does not run: a tampered
 * continuation, a changed source, another conversation's continuation, and a
 * different project key all fail with `continuation_invalid`, and the gated
 * call is never sent.
 */
let stage: McpStage;
let serverId: number;

const SEND = `await mcp.info("mail", "send_email"); return await mcp.exec("mail", "send_email", { to: "toad", subject: "hi" });`;

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
 * Park a program on its approval.
 * @param title - The conversation's first message.
 * @returns The conversation id.
 */
async function park(title: string): Promise<number> {
  stage.models.play([codeStep(SEND)]);
  const id = (await startConversation(stage, title)).body.conversation.id;
  await runTicks();
  return id;
}

/**
 * Approve the conversation's approval, let it resume, and assert the
 * continuation was refused and nothing was sent.
 * @param id - The conversation.
 */
async function approveAndExpectRefusal(id: number): Promise<void> {
  const [approval] = await approvalsOf(id);
  stage.models.play([
    {
      ...replyStep("It could not resume."),
      expect: { lastMessageIncludes: "continuation_invalid" },
    },
  ]);
  await decide(stage, approval.id, "approve");
  await runTicks();
  const [result] = await resultsOf(id, "run_code");
  expect(result).toMatchObject({
    is_error: true,
    error_type: "continuation_invalid",
  });
  expect(stage.fixture.calls).toEqual([]);
  const [run] = await codeRunsOf(id);
  expect(run.status).toBe("failed");
  expect(run.continuation).toBeNull();
}

test("a tampered continuation", async () => {
  await bindServer(stage, serverId);
  const id = await park("Tampered");
  const [run] = await codeRunsOf(id);
  const token = openContinuation(
    run.continuation as NonNullable<typeof run.continuation>,
  ) as string;
  const [head, signature] = [token.slice(0, -10), token.slice(-10)];
  const flipped = `${head}${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await api.db.db
    .update(codeRuns)
    .set({ continuation: sealContinuation(flipped) })
    .where(eq(codeRuns.id, run.id));
  await approveAndExpectRefusal(id);
});

test("a stored continuation that does not decrypt", async () => {
  await bindServer(stage, serverId);
  const id = await park("Garbled");
  const [run] = await codeRunsOf(id);
  await api.db.db
    .update(codeRuns)
    .set({
      continuation: {
        ...(run.continuation as NonNullable<typeof run.continuation>),
        ciphertext: "AAAA",
      },
    })
    .where(eq(codeRuns.id, run.id));
  await approveAndExpectRefusal(id);
});

test("a changed source", async () => {
  await bindServer(stage, serverId);
  const id = await park("Changed");
  const [run] = await codeRunsOf(id);
  const changed = SEND.replace('"toad"', '"bowser"');
  await api.db.db
    .update(conversationEntries)
    .set({
      content: { input: { source: changed } },
    })
    .where(eq(conversationEntries.id, run.entryId));
  await approveAndExpectRefusal(id);
});

test("another conversation's continuation, even of the same source", async () => {
  await bindServer(stage, serverId);
  const a = await park("First");
  const b = await park("Second");
  const [runA] = await codeRunsOf(a);
  const [runB] = await codeRunsOf(b);
  await api.db.db
    .update(codeRuns)
    .set({ continuation: runA.continuation })
    .where(eq(codeRuns.id, runB.id));
  await approveAndExpectRefusal(b);
});

test("a continuation signed with a different project key", async () => {
  await bindServer(stage, serverId);
  const id = await park("Rekeyed");
  await api.db.db
    .update(projects)
    .set({ codeContinuationKey: encryptBytes(randomBytes(32)) })
    .where(eq(projects.id, stage.u.projectId));
  await approveAndExpectRefusal(id);
});

test("the project key is created once and never serialized", async () => {
  const [row] = await api.db.db
    .select({ key: projects.codeContinuationKey })
    .from(projects)
    .where(and(eq(projects.id, stage.u.projectId)));
  expect(row.key).not.toBeNull();
  const res = await call(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}`,
  );
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain(String(row.key?.ciphertext));
  expect(JSON.stringify(res.body)).not.toContain("codeContinuationKey");
});
