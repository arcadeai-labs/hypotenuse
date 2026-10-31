import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import { runTicks, startConversation } from "../agent/harness";
import {
  buildMcpStage,
  clearLoopQueues,
  type McpStage,
  replyStep,
} from "../mcp/harness";
import { call, createTag, HOOK_TIMEOUT } from "../setup";
import { codeStep } from "./harness";

/**
 * `code-run:list` and `code-run:view` over HTTP, gated by the bot's read
 * access and never answering a continuation; and `bot:edit`'s code-mode
 * fields, whose limits may only lower the deployment's.
 */
let stage: McpStage;
let conversationId: number;

beforeAll(async () => {
  stage = await buildMcpStage();
  stage.models.play([
    codeStep("console.log('counting'); return [1, 2, 3].length"),
    replyStep(),
  ]);
  conversationId = (await startConversation(stage, "Count")).body.conversation
    .id;
  await runTicks();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  stage.models.reset();
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** The project's path. */
const p = () => `/project/${stage.u.projectId}`;

test("list and view a conversation's runs, paginated, with no continuation", async () => {
  const list = await call<{
    codeRuns: Record<string, unknown>[];
    pagination: Record<string, number>;
  }>(
    stage.u.url,
    stage.u.toad,
    "GET",
    `${p()}/conversation/${conversationId}/code-runs`,
  );
  expect(list.status).toBe(200);
  expect(list.body.pagination).toMatchObject({ page: 1, total: 1 });
  const [run] = list.body.codeRuns;
  expect(run).toMatchObject({
    conversationId,
    status: "completed",
    source: "console.log('counting'); return [1, 2, 3].length",
    output: { result: 3, console: ["counting"] },
    approvals: [],
  });
  expect(run).not.toHaveProperty("continuation");

  const view = await call<{ codeRun: Record<string, unknown> }>(
    stage.u.url,
    stage.u.toad,
    "GET",
    `${p()}/code-run/${run.id}`,
  );
  expect(view.status).toBe(200);
  expect(view.body.codeRun.id).toBe(run.id);
  expect(view.body.codeRun).not.toHaveProperty("continuation");
});

test("someone who cannot read the bot gets the same 404 as a missing run", async () => {
  const list = await call<{ codeRuns: { id: number }[] }>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `${p()}/conversation/${conversationId}/code-runs`,
  );
  const runId = list.body.codeRuns[0].id;
  await createTag(stage.u.url, stage.u.peach, stage.u.projectId, "stewards");
  const locked = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `${p()}/bot/${stage.botId}`,
    { accessRead: ["stewards"], accessWrite: ["stewards"] },
  );
  expect(locked.status).toBe(200);
  try {
    for (const path of [
      `${p()}/conversation/${conversationId}/code-runs`,
      `${p()}/code-run/${runId}`,
    ]) {
      expect(
        (await call(stage.u.url, stage.u.toad, "GET", path)).status,
        path,
      ).toBe(404);
    }
    expect(
      (await call(stage.u.url, stage.u.toad, "GET", `${p()}/code-run/999999`))
        .status,
    ).toBe(404);
  } finally {
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `${p()}/bot/${stage.botId}`,
      {
        accessRead: [],
        accessWrite: [],
      },
    );
  }
});

test("bot:edit lowers code-mode limits, refuses raising one, and toggles code mode, audited", async () => {
  const path = `${p()}/bot/${stage.botId}`;
  const raised = await call(stage.u.url, stage.u.peach, "POST", path, {
    codeLimits: { timeoutMs: config.code.timeoutMs + 1 },
  });
  expect(raised.status).toBe(406);
  expect(JSON.stringify(raised.body)).toContain("may only lower");

  const lowered = await call<{ bot: Record<string, unknown> }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    path,
    {
      codeLimits: { timeoutMs: 5_000, bridgeRequests: 20 },
      codeModeEnabled: false,
    },
  );
  expect(lowered.status).toBe(200);
  expect(lowered.body.bot).toMatchObject({
    codeModeEnabled: false,
    codeLimits: { timeoutMs: 5_000, bridgeRequests: 20 },
  });
  const [row] = await api.db.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, "bot:edit"))
    .orderBy(desc(auditLogs.id))
    .limit(1);
  expect(row.before).toMatchObject({ codeModeEnabled: true, codeLimits: {} });
  expect(row.after).toMatchObject({
    codeModeEnabled: false,
    codeLimits: { timeoutMs: 5_000, bridgeRequests: 20 },
  });
  await call(stage.u.url, stage.u.peach, "POST", path, {
    codeLimits: {},
    codeModeEnabled: true,
  });
});
