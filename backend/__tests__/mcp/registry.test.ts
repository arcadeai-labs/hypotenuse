import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { pooledKeys } from "../../ops/McpClientOps";
import { auditLogs } from "../../schema/audit_logs";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { mcpServers } from "../../schema/mcp_servers";
import { runTicks, startConversation } from "../agent/harness";
import { call, cookieHeader, HOOK_TIMEOUT } from "../setup";
import {
  addServer,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  infoThenExec,
  type McpStage,
  replyStep,
} from "./harness";

/**
 * The registry: connecting over none, headers, bearer, and OAuth (the full
 * PKCE hop against the fixture's own authorization server), the SSRF guard at
 * configuration and at every connect, per-bot header templates, a credential
 * change retiring pooled clients, and a 401 refreshing an OAuth token once.
 */
let stage: McpStage;
let network: typeof config.network;
let applicationUrl: string;

beforeAll(async () => {
  stage = await buildMcpStage();
  network = { ...config.network };
  applicationUrl = config.server.web.applicationUrl;
}, HOOK_TIMEOUT);

afterEach(async () => {
  Object.assign(config.network, network);
  config.server.web.applicationUrl = applicationUrl;
  stage.fixture.setAuth({ mode: "none" });
  stage.fixture.reset();
  await clearLoopQueues();
  stage.models.reset();
  await api.db.db.delete(botMcpServers);
  await api.db.db.delete(mcpServers);
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * View a server over HTTP.
 * @param id - The server.
 * @returns The body.
 */
async function view(id: number) {
  const res = await call<{
    mcpServer: Record<string, unknown>;
    tools: { name: string }[];
  }>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/mcp-server/${id}`,
  );
  return res.body;
}

describe("auth modes", () => {
  test("none: connects at create and caches the catalog", async () => {
    const server = await addServer(stage);
    expect(server).toMatchObject({
      status: "ok",
      authMode: "none",
      toolCount: 7,
    });
    const body = await view(server.id);
    expect(body.tools.map((t) => t.name)).toContain("mail/send_email");
  });

  test("bearer: the token is sent, sealed, and never returned", async () => {
    stage.fixture.setAuth({ mode: "bearer", token: "bearer-secret-123456" });
    const server = await addServer(stage, {
      name: "bearer",
      authMode: "bearer",
      bearerToken: "bearer-secret-123456",
    });
    expect(server).toMatchObject({ status: "ok", lastFour: "3456" });
    expect(JSON.stringify(server)).not.toContain("bearer-secret");
    const [row] = await api.db.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, server.id));
    expect(JSON.stringify(row)).not.toContain("bearer-secret");

    const wrong = await addServer(stage, {
      name: "bearer-wrong",
      authMode: "bearer",
      bearerToken: "not-it-000000",
    });
    expect(wrong.status).toBe("error");
    expect(String(wrong.lastError)).toContain("401");
  });

  test("headers: names are shown, values are not, and {{bot.identity}} is filled per bot", async () => {
    stage.fixture.setAuth({
      mode: "headers",
      name: "x-api-key",
      value: "header-secret-abcdef",
    });
    const server = await addServer(stage, {
      name: "gateway",
      authMode: "headers",
      headers: {
        "X-Api-Key": "header-secret-abcdef",
        "Arcade-User-ID": "{{bot.identity}}",
      },
    });
    expect(server).toMatchObject({
      status: "ok",
      headerNames: ["Arcade-User-ID", "X-Api-Key"],
    });
    expect(JSON.stringify(server)).not.toContain("header-secret");
    // The connection test, with no bot, sends the test identity.
    expect(stage.fixture.requestHeaders[0]["arcade-user-id"]).toBe(
      "hypotenuse-test",
    );

    await bindServer(stage, server.id, { allowedTools: ["gateway/*"] });
    stage.fixture.reset();
    stage.models.play([...infoThenExec("gateway/read_inbox"), replyStep()]);
    await startConversation(stage, "Inbox?");
    await runTicks();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["read_inbox"]);
    expect(stage.fixture.calls[0].headers["arcade-user-id"]).toBe(
      `hypotenuse-${stage.u.projectId}-${stage.botId}`,
    );

    // The audit row of the create kept neither header values nor names' values.
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "mcp-server:create"))
      .orderBy(auditLogs.id);
    expect(JSON.stringify(audit)).not.toContain("header-secret");
  });

  test("oauth: discovery, dynamic registration, PKCE, the callback, and a refresh on 401", async () => {
    stage.fixture.setAuth({ mode: "oauth" });
    config.server.web.applicationUrl = stage.u.url;
    const server = await addServer(stage, {
      name: "oauthed",
      authMode: "oauth",
    });
    expect(server).toMatchObject({ status: "needs_auth", signedIn: false });

    const start = await fetch(
      `${stage.u.url}/api/project/${stage.u.projectId}/mcp-server/${server.id}/oauth`,
      { headers: cookieHeader(stage.u.peach.sessionId), redirect: "manual" },
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") ?? "");
    expect(authorize.origin).toBe(stage.fixture.origin);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(stage.fixture.url);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(stage.fixture.registeredClients).toEqual(["client-1"]);

    const consent = await fetch(authorize, { redirect: "manual" });
    const back = new URL(consent.headers.get("location") ?? "");
    expect(back.pathname).toBe("/api/mcp-server/oauth/callback");
    // The callback needs no session: the state names the admin.
    const landed = await fetch(back, { redirect: "manual" });
    expect(landed.status).toBe(302);
    const dashboard = new URL(landed.headers.get("location") ?? "");
    expect(dashboard.pathname).toBe("/settings/mcp-servers");
    expect(dashboard.searchParams.get("signedIn")).toBe("1");

    const after = await view(server.id);
    expect(after.mcpServer).toMatchObject({
      status: "ok",
      signedIn: true,
      toolCount: 7,
    });
    expect(stage.fixture.tokenGrants.authorization_code).toBe(1);

    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "mcp-server:oauth-callback"));
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(stage.u.peach.userId);
    expect(rows[0].metadata).toMatchObject({ signedIn: true });
    expect(JSON.stringify(rows[0])).not.toContain("code-");

    // The state works once.
    const again = await fetch(back, { redirect: "manual" });
    expect(again.status).toBe(406);

    // A revoked token: one refresh, one retry, and it works.
    stage.fixture.revokeAccessTokens();
    const tested = await call<{ ok: boolean }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/mcp-server/${server.id}/test`,
      {},
    );
    expect(tested.body.ok).toBe(true);
    expect(stage.fixture.tokenGrants.refresh_token).toBe(1);
    const [row] = await api.db.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, server.id));
    expect(row.credentialVersion).toBe(3);
    expect(JSON.stringify(row)).not.toContain("at-");
  });

  test("oauth-start and the callback are never MCP tools", () => {
    for (const name of [
      "mcp-server:oauth-start",
      "mcp-server:oauth-callback",
    ]) {
      const action = api.actions.actions.find((a) => a.name === name);
      expect(action?.mcp?.tool, name).toBe(false);
    }
  });
});

describe("the SSRF guard", () => {
  test("a private address is refused at configuration", async () => {
    config.network.allowPrivateHosts = false;
    const res = await call<{ error: { key?: string; message: string } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/mcp-server`,
      { name: "local", url: "https://127.0.0.1/mcp", authMode: "none" },
    );
    expect(res.status).toBe(406);
    expect(res.body.error.key).toBe("url");
    expect(res.body.error.message).toContain("not a public address");
  });

  test("and at every connect: a server configured before is refused when its address is not public", async () => {
    const server = await addServer(stage);
    stage.fixture.reset();
    config.network.allowPrivateHosts = false;
    const tested = await call<{ ok: boolean; error: string }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/mcp-server/${server.id}/test`,
      {},
    );
    expect(tested.body.ok).toBe(false);
    expect(tested.body.error).toMatch(/https|public/);
    expect(stage.fixture.requestHeaders).toEqual([]);
  });
});

describe("the client pool", () => {
  test("a credential rotation retires the pooled client", async () => {
    stage.fixture.setAuth({ mode: "bearer", token: "first-token-111111" });
    const server = await addServer(stage, {
      name: "rotating",
      authMode: "bearer",
      bearerToken: "first-token-111111",
    });
    expect(pooledKeys().some((k) => k.startsWith(`${server.id}:1:`))).toBe(
      true,
    );
    stage.fixture.setAuth({ mode: "bearer", token: "second-token-22222" });
    const edited = await call<{
      mcpServer: { status: string; credentialVersion: number };
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/mcp-server/${server.id}`,
      { bearerToken: "second-token-22222" },
    );
    expect(edited.body.mcpServer).toMatchObject({
      status: "ok",
      credentialVersion: 2,
    });
    expect(pooledKeys().some((k) => k.startsWith(`${server.id}:1:`))).toBe(
      false,
    );
    expect(pooledKeys().some((k) => k.startsWith(`${server.id}:2:`))).toBe(
      true,
    );
  });
});
