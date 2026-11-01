import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { MODEL_KEY, startConversation } from "../agent/harness";
import { type McpFixture, startMcpFixture } from "../fixtures/mcp-server";
import { addServer, bindServer, type McpStage } from "../mcp/harness";
import { HOOK_TIMEOUT, runAction } from "../setup";
import { buildSandboxStage, jobRow, mintJob } from "./harness";

/**
 * **The proxies**: what a sandbox holds is its job token, and these attach
 * the real credentials server-side. The model proxy forwards only the
 * messages path, only the bot's own models, signs with the connection's key,
 * and stops a job over its token budget with a 402. The MCP gateway serves
 * the bot's shared servers with their credentials attached, listing and
 * calling only what the bot may call without asking.
 */
let stage: McpStage;
let fixture: McpFixture;
let serverId: number;

beforeAll(async () => {
  const base = await buildSandboxStage("allow");
  fixture = startMcpFixture({
    auth: { mode: "bearer", token: "fixture-secret-123456" },
  });
  stage = { ...base, fixture };
  serverId = (
    await addServer(stage, {
      name: "mail",
      authMode: "bearer",
      bearerToken: "fixture-secret-123456",
    })
  ).id;
  await runAction("mcp-server:refresh-catalog", { mcpServerId: serverId });
  const bound = await bindServer(stage, serverId, {
    allowedTools: ["mail/read_inbox", "mail/echo_headers"],
  });
  if (bound.status !== 200) throw new Error(JSON.stringify(bound.body));
}, HOOK_TIMEOUT);

afterAll(async () => {
  await fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A running job on a fresh conversation.
 * @param extra - Columns.
 * @returns The job and token.
 */
async function job(extra: Partial<typeof sandboxJobs.$inferInsert> = {}) {
  const res = await startConversation(stage, "Hello", { channelType: "web" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return mintJob(stage, res.body.conversation.id, extra);
}

/**
 * A model request as the coding CLI sends it.
 * @param token - The bearer.
 * @param body - The body.
 * @param path - The path after the provider.
 * @returns The response.
 */
function model(
  token: string,
  body: Record<string, unknown>,
  path = "/v1/messages",
) {
  return fetch(`${stage.u.url}/api/proxy/model/anthropic${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

/**
 * A JSON-RPC request to the gateway.
 * @param token - The bearer.
 * @param method - The method.
 * @param params - Its params.
 * @param id - The server.
 * @returns The status and body.
 */
async function gateway(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  id = serverId,
) {
  const res = await fetch(`${stage.u.url}/api/proxy/mcp/${id}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      result?: {
        tools?: { name: string }[];
        isError?: boolean;
        content?: { text: string }[];
      };
    },
  };
}

describe("the model proxy", () => {
  test("signs the bot's model request with the connection's key, and records the usage", async () => {
    const { job: j, token } = await job();
    stage.models.script("Hello from the model.");
    const res = await model(token, {
      model: "scripted-large",
      max_tokens: 32,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("Hello from the model.");
    const seen = stage.models.requests.at(-1);
    expect(seen?.headers["x-api-key"]).toBe(MODEL_KEY);
    expect(JSON.stringify(seen?.headers)).not.toContain(token);
    await Bun.sleep(100);
    expect((await jobRow(j.id)).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      requests: 1,
    });
  });

  test("refuses another path, another model, and no token", async () => {
    const { token } = await job();
    expect(
      (await model(token, { model: "scripted-large" }, "/v1/models")).status,
    ).toBe(404);
    const other = await model(token, {
      model: "claude-the-expensive-one",
      max_tokens: 8,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(other.status).toBe(400);
    expect(JSON.stringify(await other.json())).toContain("scripted-large");
    const none = await fetch(
      `${stage.u.url}/api/proxy/model/anthropic/v1/messages`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(none.status).toBe(401);
  });

  test("over its token budget, a job gets 402 and is cancelled", async () => {
    const { job: j, token } = await job({ budgetTokens: 10 });
    stage.models.script("ok");
    const body = {
      model: "scripted-large",
      max_tokens: 8,
      messages: [{ role: "user", content: "Hi" }],
    };
    expect((await model(token, body)).status).toBe(200);
    await Bun.sleep(150);
    // 15 tokens against a budget of 10: the job is asked to stop at once.
    expect((await jobRow(j.id)).cancelRequested).toBe(true);
    const refused = await model(token, body);
    expect(refused.status).toBe(402);
    expect(JSON.stringify(await refused.json())).toContain("budget_exceeded");
  });
});

describe("the MCP gateway", () => {
  test("lists only the tools the bot may call unasked, and calls them with the server's credentials", async () => {
    const { token } = await job();
    const init = await gateway(token, "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(init.status).toBe(200);
    const listed = await gateway(token, "tools/list");
    expect(listed.body.result?.tools?.map((t) => t.name).sort()).toEqual([
      "echo_headers",
      "read_inbox",
    ]);
    const echoed = await gateway(token, "tools/call", {
      name: "echo_headers",
      arguments: {},
    });
    expect(echoed.body.result?.isError).toBe(false);
    // The server saw its credential; the sandbox never held it, and the
    // answer carries it redacted.
    expect(fixture.requestHeaders.at(-1)?.authorization).toBe(
      "Bearer fixture-secret-123456",
    );
    expect(echoed.body.result?.content?.[0]?.text).not.toContain(
      "fixture-secret-123456",
    );
    expect(echoed.body.result?.content?.[0]?.text).not.toContain(token);
  });

  test("refuses a tool outside the allowlist, and a server the bot was not given", async () => {
    const { token } = await job();
    const refused = await gateway(token, "tools/call", {
      name: "send_email",
      arguments: { to: "toad", subject: "hi" },
    });
    expect(refused.body.result?.isError).toBe(true);
    expect(refused.body.result?.content?.[0]?.text).toContain("sandbox-ask");
    expect(fixture.calls.some((c) => c.tool === "send_email")).toBe(false);
    const other = await gateway(token, "tools/list", {}, serverId + 1000);
    expect(other.status).toBe(404);
  });
});
