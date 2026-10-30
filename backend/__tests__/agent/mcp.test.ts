import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { getMcpAccessToken, HOOK_TIMEOUT, TEST_PASSWORD } from "../setup";
import { type AgentStage, buildAgentStage, runTicks } from "./harness";

/**
 * A person's MCP client talks to a bot through the same actions: it starts a
 * conversation, the bot answers in the background, and the client reads the
 * transcript.
 */
let stage: AgentStage;
let token: string;
let sessionId: string | null = null;
let nextId = 1;

/**
 * Send one JSON-RPC message to `/mcp`.
 * @param method - The method.
 * @param params - Its params.
 * @returns The parsed result.
 */
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${stage.u.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId ??= res.headers.get("mcp-session-id");
  const text = await res.text();
  const payload = /^(event|data|id):/m.test(text.trimStart().split("\n")[0])
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  return JSON.parse(payload) as {
    result?: { isError?: boolean; content?: { text: string }[] };
  };
}

/**
 * A tool call's JSON answer.
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The parsed answer.
 */
async function tool(name: string, args: Record<string, unknown>) {
  const res = await mcp("tools/call", { name, arguments: args });
  expect(res.result?.isError ?? false).toBe(false);
  return JSON.parse(res.result?.content?.[0]?.text ?? "null");
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  token = await getMcpAccessToken(
    stage.u.url,
    stage.u.mario.email,
    TEST_PASSWORD,
  );
  await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("over MCP", () => {
  test("conversation-create, then conversation-entries reads the bot's reply", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Via MCP." } }] },
    ]);
    const created = await tool("conversation-create", {
      projectId: stage.u.projectId,
      botId: stage.botId,
      text: "Hello from a client.",
    });
    const id = created.conversation.id;
    await runTicks();
    const read = await tool("conversation-entries", {
      projectId: stage.u.projectId,
      conversationId: id,
      limit: 100,
    });
    expect(read.conversation.state).toBe("hibernating");
    const reply = read.entries.find(
      (e: { toolName: string; kind: string }) =>
        e.kind === "tool_call_intent" && e.toolName === "reply_and_wait",
    );
    expect(reply.content.input.text).toBe("Via MCP.");
  });
});
