import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callDaemon } from "../../src/daemon/control-client";
import { ControlServer } from "../../src/daemon/control-socket";
import { McpBroker } from "../../src/daemon/mcp-broker";
import { createMcpServer } from "../../src/mcp/server";

/**
 * `hypotenuse mcp` as an agent sees it: an MCP SDK client against the server,
 * which reaches a real control socket whose broker stands in for the daemon.
 */

const socket = join(mkdtempSync(join(tmpdir(), "hypm-")), "d.sock");
const calls: { route: string; body: Record<string, unknown> }[] = [];
const broker = new McpBroker({
  tool: async (route, body) => {
    calls.push({ route, body });
    return { text: `# ENG-7\nFrom ${route}`, data: { route } };
  },
});
const control = new ControlServer(socket, {
  "mcp.hello": (p) => broker.hello(p),
  "mcp.call": (p) => broker.call(p),
});
beforeAll(() => control.listen());
afterAll(() => control.close());

/**
 * Connect a client to a fresh server for a session and nonce.
 * @param agentSessionId - The session.
 * @param nonce - The nonce.
 * @returns The client.
 */
async function connect(agentSessionId: number, nonce: string) {
  const server = await createMcpServer({
    agentSessionId,
    nonce,
    call: (method, params, timeoutMs) =>
      callDaemon(socket, method, params, timeoutMs),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fake-agent", version: "1.0.0" });
  await client.connect(b);
  return client;
}

/** A turn for the broker. */
function turnFor(role: "worker" | "manager", agentSessionId: number) {
  return broker.register({
    agentSessionId,
    workItemId: agentSessionId * 10,
    role,
    issueIdentifier: "ENG-7",
    askingUser: () => {},
    settle: async () => {},
    reportedPullRequest: () => {},
  });
}

describe("the tool list", () => {
  test("a worker sees exactly its eight tools, described, with schemas", async () => {
    const client = await connect(1, turnFor("worker", 1));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "linear_get_issue",
      "linear_list_comments",
      "linear_comment",
      "linear_set_issue_state",
      "linear_set_plan",
      "linear_ask_user",
      "linear_report_pr",
      "linear_search_issues",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(client.getInstructions()).toContain("ENG-7");
    await client.close();
  });

  test("a manager sees all eighteen", async () => {
    const client = await connect(2, turnFor("manager", 2));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(18);
    expect(tools.map((t) => t.name)).toContain("hypotenuse_dispatch");
    await client.close();
  });

  test("a bad nonce starts with zero tools and says why", async () => {
    const client = await connect(3, "0".repeat(32));
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    expect(client.getInstructions()).toContain(
      "Hypotenuse's Linear tools are not available in this session",
    );
    const call = await client.callTool({
      name: "linear_get_issue",
      arguments: {},
    });
    expect(call.isError).toBe(true);
    await client.close();
  });
});

describe("calls", () => {
  test("a call reaches the daemon and answers Markdown and data", async () => {
    calls.length = 0;
    const client = await connect(4, turnFor("worker", 4));
    const result = await client.callTool({
      name: "linear_get_issue",
      arguments: { issue: "ENG-7" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "# ENG-7\nFrom /daemon/linear/get-issue" },
    ]);
    expect(result.structuredContent).toEqual({
      route: "/daemon/linear/get-issue",
    });
    expect(calls).toEqual([
      {
        route: "/daemon/linear/get-issue",
        body: { issue: "ENG-7", agentSessionId: 4 },
      },
    ]);
    await client.close();
  });

  test("invalid input is a tool error, not a crash, and the server keeps serving", async () => {
    const client = await connect(5, turnFor("worker", 5));
    const bad = await client.callTool({
      name: "linear_ask_user",
      arguments: { question: "Which?", options: [{ label: "only one" }] },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]?.text).toContain("options");
    const unknown = await client.callTool({
      name: "linear_create_issue",
      arguments: { title: "x" },
    });
    expect(unknown.isError).toBe(true);
    const good = await client.callTool({
      name: "linear_get_issue",
      arguments: {},
    });
    expect(good.isError).toBeFalsy();
    await client.close();
  });
});
