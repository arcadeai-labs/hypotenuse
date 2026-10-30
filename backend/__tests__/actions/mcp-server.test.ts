import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import { addServer, buildMcpStage, type McpStage } from "../mcp/harness";
import { call, HOOK_TIMEOUT } from "../setup";

/**
 * RBAC and audit for the MCP server and bot-server actions: admins configure
 * servers, members read them, a bot's writers give it servers, outsiders get
 * nothing, and every decision is one audit row without a credential in it.
 */
let stage: McpStage;
let p: string;

beforeAll(async () => {
  stage = await buildMcpStage();
  p = `/project/${stage.u.projectId}`;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The newest audit row of an action.
 * @param action - The action name.
 * @returns The row.
 */
async function lastAudit(action: string) {
  const rows = await api.db.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(auditLogs.id);
  return rows.at(-1);
}

describe("mcp-server:*", () => {
  test("only an admin configures a server; members read; outsiders get nothing", async () => {
    const body = {
      name: "denied",
      url: stage.fixture.url,
      authMode: "bearer",
      bearerToken: "tok-should-not-store",
    };
    for (const user of [stage.u.mario, stage.u.toad]) {
      const res = await call(stage.u.url, user, "PUT", `${p}/mcp-server`, body);
      expect(res.status, user.email).toBe(403);
    }
    expect(
      (await call(stage.u.url, stage.u.bowser, "GET", `${p}/mcp-servers`))
        .status,
    ).toBe(403);

    const server = await addServer(stage, {
      headers: { "X-Key": "a-header-secret-1" },
      authMode: "headers",
    });
    const audit = await lastAudit("mcp-server:create");
    expect(audit?.userId).toBe(stage.u.peach.userId);
    expect(audit?.after).toMatchObject({
      name: "mail",
      headerNames: ["X-Key"],
    });
    expect(JSON.stringify(audit)).not.toContain("a-header-secret-1");

    const list = await call<{ mcpServers: unknown[]; pagination: unknown }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `${p}/mcp-servers`,
    );
    expect(list.status).toBe(200);
    expect(list.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect(
      (
        await call(
          stage.u.url,
          stage.u.toad,
          "GET",
          `${p}/mcp-server/${server.id}`,
        )
      ).status,
    ).toBe(200);
    const match = await call<{
      matches: { pattern: string; tools: string[] }[];
      gated: string[];
    }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `${p}/mcp-server/${server.id}/match?patterns=${encodeURIComponent("a/b/c\nsend_email")}`,
    );
    expect(match.status).toBe(406);
    const ok = await call<{
      matches: { pattern: string; tools: string[] }[];
      gated: string[];
    }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `${p}/mcp-server/${server.id}/match?patterns=${encodeURIComponent("/^mail\\/read_/\nsend_email")}`,
    );
    expect(ok.body.matches).toEqual([
      { pattern: "/^mail\\/read_/", tools: ["mail/read_inbox"] },
      { pattern: "send_email", tools: ["mail/send_email"] },
    ]);
    expect(ok.body.gated).not.toContain("mail/send_email");

    for (const [method, path] of [
      ["POST", `${p}/mcp-server/${server.id}`],
      ["POST", `${p}/mcp-server/${server.id}/test`],
      ["POST", `${p}/mcp-server/${server.id}/refresh`],
      ["DELETE", `${p}/mcp-server/${server.id}`],
    ] as const) {
      const res = await call(stage.u.url, stage.u.toad, method, path, {});
      expect(res.status, path).toBe(403);
    }

    const renamed = await call<{ mcpServer: { name: string } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `${p}/mcp-server/${server.id}`,
      { name: "mailbox", timeoutMs: 5000 },
    );
    expect(renamed.body.mcpServer.name).toBe("mailbox");
    expect((await lastAudit("mcp-server:edit"))?.before).toMatchObject({
      name: "mail",
    });
    const refreshed = await call<{ ok: boolean; toolCount: number }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `${p}/mcp-server/${server.id}/refresh`,
      {},
    );
    expect(refreshed.body).toMatchObject({ ok: true, toolCount: 7 });
    expect(await lastAudit("mcp-server:refresh-tools")).toBeDefined();

    const taken = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${p}/mcp-server`,
      {
        name: "mailbox",
        url: stage.fixture.url,
        authMode: "none",
      },
    );
    expect(taken.status).toBe(406);

    const deleted = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `${p}/mcp-server/${server.id}`,
    );
    expect(deleted.status).toBe(200);
    expect((await lastAudit("mcp-server:delete"))?.before).toMatchObject({
      name: "mailbox",
    });
  });
});

describe("bot-mcp-server:*", () => {
  test("a bot's writers give it servers; readers list them; others cannot", async () => {
    const server = await addServer(stage, { name: "tools" });
    // Only operators (Mario) may write Toadsworth.
    await call(stage.u.url, stage.u.peach, "POST", `${p}/bot/${stage.botId}`, {
      accessWrite: ["operators"],
    });
    const toad = await call(
      stage.u.url,
      stage.u.toad,
      "PUT",
      `${p}/bot/${stage.botId}/mcp-server`,
      { mcpServerId: server.id },
    );
    expect(toad.status).toBe(403);
    const bad = await call(
      stage.u.url,
      stage.u.mario,
      "PUT",
      `${p}/bot/${stage.botId}/mcp-server`,
      { mcpServerId: server.id, allowedTools: ["a/b/c"] },
    );
    expect(bad.status).toBe(406);
    const set = await call<{ botMcpServer: Record<string, unknown> }>(
      stage.u.url,
      stage.u.mario,
      "PUT",
      `${p}/bot/${stage.botId}/mcp-server`,
      {
        mcpServerId: server.id,
        allowedTools: ["tools/read_inbox"],
        autoAllowReadOnly: true,
      },
    );
    expect(set.status).toBe(200);
    expect(set.body.botMcpServer).toMatchObject({
      allowedTools: ["tools/read_inbox"],
      autoAllowReadOnly: true,
      server: { name: "tools", toolCount: 7 },
    });
    const audit = await lastAudit("bot-mcp-server:set");
    expect(audit?.after).toMatchObject({ autoAllowReadOnly: true });
    expect(audit?.targetPath).toBe("toadsworth/tools");

    const list = await call<{ botMcpServers: unknown[] }>(
      stage.u.url,
      stage.u.toad,
      "GET",
      `${p}/bot/${stage.botId}/mcp-servers`,
    );
    expect(list.status).toBe(200);
    expect(list.body.botMcpServers.length).toBe(1);

    expect(
      (
        await call(
          stage.u.url,
          stage.u.toad,
          "DELETE",
          `${p}/bot/${stage.botId}/mcp-server/${server.id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.mario,
          "DELETE",
          `${p}/bot/${stage.botId}/mcp-server/${server.id}`,
        )
      ).status,
    ).toBe(200);
    expect((await lastAudit("bot-mcp-server:remove"))?.before).toMatchObject({
      allowedTools: ["tools/read_inbox"],
    });
  });
});
