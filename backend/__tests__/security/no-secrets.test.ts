import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import { runTicks, startConversation } from "../agent/harness";
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
 * result — even when a tool echoes the request's headers back.
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
