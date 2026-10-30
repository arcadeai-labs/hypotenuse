import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { api, config } from "keryx";
import { conversations } from "../../schema/conversations";
import { largeResults } from "../../schema/large_results";
import { memoryDocuments } from "../../schema/memory_documents";
import { runTicks, startConversation } from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  addServer,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  infoThenExec,
  type McpStage,
  replyStep,
  resultsOf,
} from "./harness";

/**
 * Large results: a result over `MCP_MAX_INLINE_CHARS` is stored and
 * previewed, paged by `read_large_result` and `large-result:view`, written
 * whole to memory with `saveTo`, and swept after its conversation ends.
 */
let stage: McpStage;

beforeAll(async () => {
  stage = await buildMcpStage();
  const server = await addServer(stage);
  await bindServer(stage, server.id, { allowedTools: ["mail/*"] });
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("large results", () => {
  test("a huge result → a preview and an id → paged reads, here and over HTTP", async () => {
    stage.models.play([
      ...infoThenExec("mail/huge_report", { chars: 30_000 }),
      replyStep(),
    ]);
    const id = (await startConversation(stage, "Report")).body.conversation.id;
    await runTicks();
    const [exec] = await resultsOf(id, "mcp_exec");
    expect(exec).toMatchObject({
      name: "mail/huge_report",
      truncated: true,
      totalChars: 30_000,
    });
    expect(String(exec.preview).length).toBe(config.mcp.previewChars);
    expect(String(exec.hint)).toContain("read_large_result");
    const ref = String(exec.id);
    expect(ref).toMatch(/^lr_\d+$/);
    // The model saw only the preview.
    const prompt = JSON.stringify(stage.models.completions.at(-2)?.body);
    expect(prompt.length).toBeLessThan(20_000);

    stage.models.play([
      {
        toolCalls: [
          {
            name: "read_large_result",
            input: { id: ref, offset: 29_000, limit: 5_000 },
          },
          { name: "read_large_result", input: { id: "lr_999999" } },
        ],
      },
      replyStep(),
    ]);
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${id}/message`,
      { text: "Read the end" },
    );
    await runTicks();
    const reads = await resultsOf(id, "read_large_result");
    const page = reads.find((r) => r.totalChars === 30_000);
    const missing = reads.find(
      (r) =>
        r.is_error === true &&
        r.error_type === "not_found" &&
        String(r.message).includes("lr_999999"),
    );
    expect(page).toMatchObject({ offset: 29_000, nextOffset: null });
    expect(String(page?.text).length).toBe(1_000);
    expect(missing).toBeDefined();

    const http = await call<{
      largeResult: { totalChars: number; conversationId: number };
      page: { text: string; nextOffset: number | null };
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/large-result/${ref.slice(3)}?offset=0&limit=100`,
    );
    expect(http.status).toBe(200);
    expect(http.body.largeResult).toMatchObject({
      totalChars: 30_000,
      conversationId: id,
    });
    expect(http.body.page.text.length).toBe(100);
    expect(http.body.page.nextOffset).toBe(100);
    const outsider = await call(
      stage.u.url,
      stage.u.bowser,
      "GET",
      `/project/${stage.u.projectId}/large-result/${ref.slice(3)}`,
    );
    expect(outsider.status).toBe(403);
  });

  test("saveTo writes the whole result to channel memory and acknowledges", async () => {
    stage.models.play([
      ...infoThenExec(
        "mail/huge_report",
        { chars: 20_000 },
        { saveTo: { path: "reports/huge.md" } },
      ),
      replyStep(),
    ]);
    const id = (await startConversation(stage, "Save the report")).body
      .conversation.id;
    await runTicks();
    const [exec] = await resultsOf(id, "mcp_exec");
    expect(exec).toMatchObject({
      name: "mail/huge_report",
      saved: { path: "reports/huge.md", scope: "channel" },
      totalChars: 20_000,
    });
    const [doc] = await api.db.db
      .select()
      .from(memoryDocuments)
      .where(eq(memoryDocuments.logicalPath, "reports/huge.md"));
    expect(doc.content.length).toBe(20_000);
    expect(doc.sourceType).toBe("agent");
  });

  test("the sweep deletes results of conversations that ended long ago, and keeps the rest", async () => {
    const rows = await api.db.db.select().from(largeResults);
    expect(rows.length).toBeGreaterThan(0);
    const ended = rows[0].conversationId;
    await api.db.db
      .update(conversations)
      .set({ state: "ended", outcome: "completed" })
      .where(eq(conversations.id, ended));
    expect(
      (await runAction<{ deleted: number }>("large-results:sweep", {})).deleted,
    ).toBe(0);
    await api.db.db.execute(
      sql`update conversations set updated_at = now() - interval '31 days' where id = ${ended}`,
    );
    expect(
      (await runAction<{ deleted: number }>("large-results:sweep", {})).deleted,
    ).toBe(rows.filter((r) => r.conversationId === ended).length);
  });
});
