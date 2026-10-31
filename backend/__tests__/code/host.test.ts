import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { approvals } from "../../schema/approvals";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { bots } from "../../schema/bots";
import { memoryDocuments } from "../../schema/memory_documents";
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
import { codeRunsOf, codeStep } from "./harness";

/**
 * The host API holds the same policy as the top-level tools: memory is the
 * conversation's read set and channel writes only; `mcp.exec` respects the
 * allowlist and info-before-exec; `mcp.capture` writes the whole result to
 * memory and returns only an acknowledgement; and a bot with code mode off is
 * not offered `run_code`.
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
  await api.db.db.delete(memoryDocuments);
  await api.db.db
    .update(bots)
    .set({ codeModeEnabled: true })
    .where(eq(bots.id, stage.botId));
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run one program in a new conversation and return its result.
 * @param source - The program.
 * @param channelKey - The API channel.
 * @returns The conversation id and the program's result.
 */
async function runOnce(source: string, channelKey = "default") {
  stage.models.play([codeStep(source), replyStep()]);
  const id = (await startConversation(stage, "Work it out", { channelKey }))
    .body.conversation.id;
  await runTicks();
  const [result] = await resultsOf(id, "run_code");
  return { id, result };
}

test("memory is the conversation's: a program writes channel memory, and another channel's program cannot find it", async () => {
  const written = await runOnce(`
    const w = await memory.write("facts/cake.json", { flavour: "lemon", tiers: 3 }, { changeNote: "from the baker" });
    const back = await memory.read("facts/cake.json");
    const found = await memory.search("lemon");
    const listed = await memory.list({ pathPrefix: "facts/" });
    return { w, back, hits: found.hits.length, listed: listed.total };
  `);
  expect(written.result).toMatchObject({
    result: {
      w: { path: "facts/cake.json", scope: "channel" },
      back: { flavour: "lemon", tiers: 3 },
      listed: 1,
    },
  });
  const [doc] = await api.db.db
    .select()
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.logicalPath, "facts/cake.json"),
        eq(memoryDocuments.isCurrent, true),
      ),
    );
  expect(doc.scope).toBe("channel");
  expect(doc.sourceType).toBe("agent");
  expect(doc.changeNote).toBe("from the baker");

  const other = await runOnce(
    `try { return await memory.read("facts/cake.json"); } catch (e) { return { reason: e.code }; }`,
    "elsewhere",
  );
  expect(other.result).toMatchObject({ result: { reason: "not_found" } });
});

test("a program cannot write project memory", async () => {
  const { result } = await runOnce(
    `try { await memory.write("facts/x.md", "x", { scope: "project" }); return "wrote"; } catch (e) { return e.code; }`,
  );
  expect(result).toMatchObject({ result: "project_write_refused" });
});

test("mcp.exec requires mcp.info first, as mcp_exec does", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  const { result } = await runOnce(
    `try { return await mcp.exec("mail", "read_inbox"); } catch (e) { return e.code; }`,
  );
  expect(result).toMatchObject({ result: "mcp:info_required" });
  expect(stage.fixture.calls).toEqual([]);
});

test("mcp.exec respects the allowlist: a tool outside it waits for approval", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/read_inbox"] });
  stage.models.play([
    codeStep(
      'await mcp.info("mail", "create_pull_request"); return await mcp.exec("mail", "create_pull_request", { branch: "x" })',
    ),
  ]);
  const id = (await startConversation(stage, "Open it")).body.conversation.id;
  await runTicks();
  expect((await conversationRow(id)).state).toBe("waiting");
  expect((await approvalsOf(id)).map((a) => a.tool)).toEqual([
    "create_pull_request",
  ]);
  expect(stage.fixture.calls).toEqual([]);
});

test("an unknown server or tool is refused as an mcp error", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  const { result } = await runOnce(`return await mcp.info("nope", "x")`);
  expect(result).toMatchObject({
    is_error: true,
    error_type: "mcp_error",
    hostErrorType: "not_found",
  });
});

test("mcp.capture writes the whole result to channel memory and returns no payload", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  const { result } = await runOnce(`
    await mcp.info("mail", "huge_report");
    const ack = await mcp.capture("mail", "huge_report", { chars: 50000 }, "exports/report.md");
    const text = await memory.read("exports/report.md");
    return { ack, length: text.length };
  `);
  const out = result.result as {
    ack: Record<string, unknown>;
    length: number;
  };
  expect(out.ack).toMatchObject({
    path: "exports/report.md",
    scope: "channel",
    bytesWritten: 50_000,
  });
  expect(Object.keys(out.ack).sort()).toEqual([
    "bytesWritten",
    "path",
    "scope",
    "versionId",
  ]);
  expect(out.length).toBe(50_000);
  expect(JSON.stringify(result).length).toBeLessThan(2_000);
});

test("an oversized capture keeps the answer as a large result and says the call ran", async () => {
  await bindServer(stage, serverId, { allowedTools: ["mail/*"] });
  const { result } = await runOnce(`
    await mcp.info("mail", "huge_report");
    try {
      await mcp.capture("mail", "huge_report", { chars: ${config.memory.maxDocumentChars + 10} }, "exports/too-big.md");
      return "saved";
    } catch (e) {
      const ref = /lr_\\d+/.exec(e.message)[0];
      const page = await largeResult.read(ref, { limit: 100 });
      return { reason: e.code, ref, total: page.totalChars };
    }
  `);
  expect(result.result).toMatchObject({
    reason: "mcp:too_large",
    total: config.memory.maxDocumentChars + 10,
  });
  expect(
    stage.fixture.calls.filter((c) => c.tool === "huge_report"),
  ).toHaveLength(1);
});

test("saveTo writes the result as JSON instead of returning it", async () => {
  const { result } = await runOnce("return [1, 2, 3]", "default");
  expect(result).toMatchObject({ result: [1, 2, 3], resultCount: 3 });
  stage.models.play([
    codeStep("return { n: 42 }", {
      saveTo: { path: "results/n.json" },
      changeNote: "the answer",
    }),
    replyStep(),
  ]);
  const id = (await startConversation(stage, "Save it")).body.conversation.id;
  await runTicks();
  const [saved] = await resultsOf(id, "run_code");
  expect(saved).toMatchObject({
    path: "results/n.json",
    scope: "channel",
    preview: expect.stringContaining("42"),
  });
  expect(saved.result).toBeUndefined();
});

test('source "?" returns the primer and starts no sandbox', async () => {
  const { id, result } = await runOnce("?");
  expect(String(result.primer)).toContain("declare const mcp");
  expect(String(result.primer)).toContain("Count by day");
  expect(await codeRunsOf(id)).toEqual([]);
});

test("a bot with code mode off is not offered run_code", async () => {
  await api.db.db
    .update(bots)
    .set({ codeModeEnabled: false })
    .where(eq(bots.id, stage.botId));
  stage.models.play([replyStep()]);
  await startConversation(stage, "Hello");
  await runTicks();
  const request = JSON.stringify(stage.models.completions.at(-1));
  expect(request).not.toContain('"run_code"');
});
