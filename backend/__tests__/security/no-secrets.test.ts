import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import { openContinuation } from "../../ops/code/continuation";
import { runTicks, startConversation } from "../agent/harness";
import { codeRunsOf, codeStep } from "../code/harness";
import {
  addServer,
  bindServer,
  buildMcpStage,
  infoThenExec,
  type McpStage,
  replyStep,
  resultsOf,
} from "../mcp/harness";
import { call, cookieHeader, HOOK_TIMEOUT } from "../setup";

/**
 * No MCP credential leaves the server: not in any answer, not in the
 * transcript, not in an audit row, an approval, a notification, or a stored
 * result — even when a tool echoes the request's headers back. Nor does a
 * code-mode continuation, which carries a program's settled results.
 */
const HEADER_SECRET = "hdr-secret-9f8e7d6c5b4a";
const BEARER_SECRET = "bearer-secret-1a2b3c4d5e";
let stage: McpStage;
let conversationId: number;

beforeAll(async () => {
  stage = await buildMcpStage({
    mode: "headers",
    name: "x-api-key",
    value: HEADER_SECRET,
  });
  const gateway = await addServer(stage, {
    name: "gateway",
    authMode: "headers",
    headers: { "X-Api-Key": HEADER_SECRET },
  });
  // A second server whose bearer token is never accepted: it still must not leak.
  await addServer(stage, {
    name: "bearer",
    authMode: "bearer",
    bearerToken: BEARER_SECRET,
  });
  await bindServer(stage, gateway.id, {
    allowedTools: ["gateway/echo_headers"],
  });
  stage.models.play([
    ...infoThenExec("gateway/echo_headers"),
    ...infoThenExec("gateway/send_email", { to: "toad", subject: "x" }),
  ]);
  conversationId = (await startConversation(stage, "Echo")).body.conversation
    .id;
  await runTicks();
  stage.models.play([replyStep()]);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Assert a text holds neither secret.
 * @param label - What it is.
 * @param text - The text.
 */
function clean(label: string, text: string): void {
  expect(text.includes(HEADER_SECRET), label).toBe(false);
  expect(text.includes(BEARER_SECRET), label).toBe(false);
}

describe("no MCP credential leaves the server", () => {
  test("the server really sent it, and the echoed result was scrubbed", async () => {
    expect(stage.fixture.calls[0].headers["x-api-key"]).toBe(HEADER_SECRET);
    const [echo] = await resultsOf(conversationId, "mcp_exec");
    expect(String(echo.text)).toContain("[redacted]");
    clean("echo result", JSON.stringify(echo));
  });

  test("no answer carries one", async () => {
    const p = `/project/${stage.u.projectId}`;
    const servers = await call<{ mcpServers: { id: number }[] }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `${p}/mcp-servers`,
    );
    const paths = [
      `${p}/mcp-servers`,
      ...servers.body.mcpServers.map((s) => `${p}/mcp-server/${s.id}`),
      `${p}/bot/${stage.botId}`,
      `${p}/bot/${stage.botId}/mcp-servers`,
      `${p}/approvals`,
      `${p}/conversation/${conversationId}/entries?limit=100`,
      `${p}/audit`,
    ];
    for (const path of paths) {
      const res = await fetch(`${stage.u.url}/api${path}`, {
        headers: cookieHeader(stage.u.peach.sessionId),
      });
      const body = await res.text();
      expect(res.status, path).toBe(200);
      clean(path, body);
    }
  });

  test("no stored row outside the sealed columns carries one", async () => {
    for (const table of [
      "conversation_entries",
      "audit_logs",
      "approvals",
      "notifications",
      "large_results",
      "memory_documents",
      "bots",
      "bot_mcp_servers",
    ]) {
      const rows = await api.db.db.execute(
        sql.raw(`select row_to_json(t)::text as j from ${table} t`),
      );
      clean(table, JSON.stringify(rows.rows));
    }
    const servers = await api.db.db.execute(
      sql.raw("select row_to_json(t)::text as j from mcp_servers t"),
    );
    clean("mcp_servers (sealed)", JSON.stringify(servers.rows));
  });
});

describe("no code-mode continuation leaves the server", () => {
  test("a paused program's continuation is in no answer, entry, or row but its own sealed column", async () => {
    stage.models.reset();
    stage.models.play([
      codeStep(
        'await mcp.info("gateway", "echo_headers"); await mcp.info("gateway", "send_email"); const h = await mcp.exec("gateway", "echo_headers"); await mcp.exec("gateway", "send_email", { to: "toad", subject: "x" }); return h;',
      ),
    ]);
    const id = (await startConversation(stage, "Program")).body.conversation.id;
    await runTicks();
    const [run] = await codeRunsOf(id);
    expect(run.status).toBe("interrupted");
    const token = openContinuation(
      run.continuation as NonNullable<typeof run.continuation>,
    ) as string;
    // The token's payload (base64 of the source and the echoed headers) and
    // its signature are what must not leak.
    const [payload, signature] = token.split(".");
    expect(payload.length).toBeGreaterThan(100);
    const leaks = (label: string, text: string) => {
      expect(text.includes(signature), label).toBe(false);
      expect(text.includes(payload.slice(0, 64)), label).toBe(false);
      clean(label, text);
    };
    const p = `/project/${stage.u.projectId}`;
    for (const path of [
      `${p}/conversation/${id}/entries?limit=100`,
      `${p}/conversation/${id}/code-runs`,
      `${p}/code-run/${run.id}`,
      `${p}/approvals`,
      `${p}/audit`,
    ]) {
      const res = await fetch(`${stage.u.url}/api${path}`, {
        headers: cookieHeader(stage.u.peach.sessionId),
      });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body.includes('"continuation"'), path).toBe(false);
      leaks(path, body);
    }
    for (const table of [
      "conversation_entries",
      "audit_logs",
      "approvals",
      "notifications",
    ]) {
      const rows = await api.db.db.execute(
        sql.raw(`select row_to_json(t)::text as j from ${table} t`),
      );
      leaks(table, JSON.stringify(rows.rows));
    }
    // The run's journal carries sizes, never payloads.
    const runs = await api.db.db.execute(
      sql.raw("select host_calls::text as j, output::text as o from code_runs"),
    );
    leaks("code_runs journal", JSON.stringify(runs.rows));
  });
});
