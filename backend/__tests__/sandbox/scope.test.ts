import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  SANDBOX_MCP_TOOL_ACTION_NAMES,
  SANDBOX_ONLY_ACTION_NAMES,
} from "../../ops/McpToolPolicyOps";
import { finalizeSandboxJob } from "../../ops/SandboxJobOps";
import { type AgentStage, startConversation } from "../agent/harness";
import { call, getMcpAccessToken, HOOK_TIMEOUT, TEST_PASSWORD } from "../setup";
import { asJob, buildSandboxStage, mintJob } from "./harness";

/**
 * **Machine principals and human principals are disjoint.** A job token may
 * call only the closed sandbox list, a person none of it — over HTTP and over
 * `/mcp` — and a job reaches only its own conversation's work.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildSandboxStage("allow");
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A conversation to hang jobs on.
 * @returns Its id.
 */
async function newConversation(): Promise<number> {
  const res = await startConversation(stage, "Hello", { channelType: "web" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.conversation.id;
}

/**
 * One JSON-RPC exchange with our `/mcp`.
 * @param token - The bearer.
 * @param session - The session, once open.
 * @param method - The method.
 * @param params - Its params.
 * @returns The status, session id, and parsed body.
 */
async function mcp(
  token: string,
  session: string | null,
  method: string,
  params: Record<string, unknown> = {},
) {
  const res = await fetch(`${stage.u.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.trim().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5) ?? "{}",
      );
  return {
    status: res.status,
    session: res.headers.get("mcp-session-id") ?? session,
    body: json as {
      result?: {
        tools?: { name: string }[];
        isError?: boolean;
        content?: { text: string }[];
      };
    },
  };
}

/**
 * Open an MCP session.
 * @param token - The bearer.
 * @returns The session id.
 */
async function open(token: string): Promise<string> {
  const res = await mcp(token, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(res.status).toBe(200);
  if (!res.session) throw new Error("no session");
  return res.session;
}

describe("the closed list", () => {
  test("is exactly the supervisor's three, the in-sandbox tools, and the proxies", () => {
    expect([...SANDBOX_ONLY_ACTION_NAMES].sort() as string[]).toEqual(
      [
        "proxy:mcp",
        "proxy:model",
        "sandbox:ask",
        "sandbox:check-answer",
        "sandbox:complete",
        "sandbox:events",
        "sandbox:heartbeat",
        "sandbox:memory-search",
        "sandbox:report-status",
        "sandbox:request-help",
        "sandbox:submit-artifact",
      ].sort(),
    );
    for (const name of SANDBOX_MCP_TOOL_ACTION_NAMES) {
      expect(SANDBOX_ONLY_ACTION_NAMES as readonly string[]).toContain(name);
    }
    // Every member exists, so the list cannot rot.
    const registered = new Set(api.actions.actions.map((a) => a.name));
    for (const name of SANDBOX_ONLY_ACTION_NAMES) {
      expect(registered.has(name), name).toBe(true);
    }
  });
});

describe("over HTTP", () => {
  test("a person's session calling a sandbox action is 403", async () => {
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      "/sandbox/job/status",
      { state: "x", message: "y" },
    );
    expect(res.status).toBe(403);
  });

  test("a job token calling a human action is 403, even one its bot could reach", async () => {
    const { token } = await mintJob(stage, await newConversation());
    const res = await fetch(
      `${stage.u.url}/api/project/${stage.u.projectId}/bots`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
  });

  test("no token is 401; a token whose job ended is refused like a wrong one", async () => {
    const none = await fetch(`${stage.u.url}/api/sandbox/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(none.status).toBe(401);
    const { job, token } = await mintJob(stage, await newConversation());
    expect(
      (await asJob(stage.u.url, "POST", "/sandbox/heartbeat", token)).status,
    ).toBe(200);
    await finalizeSandboxJob(job.id, { status: "failed", reason: "test" });
    const after = await asJob(stage.u.url, "POST", "/sandbox/heartbeat", token);
    expect(after.status).toBe(401);
    const wrong = await asJob(
      stage.u.url,
      "POST",
      "/sandbox/heartbeat",
      "hyp_job_not-a-real-token",
    );
    expect(wrong.status).toBe(401);
    expect((after.body as { error: { message: string } }).error.message).toBe(
      (wrong.body as { error: { message: string } }).error.message,
    );
  });

  test("a job reaches only its own conversation's questions", async () => {
    const a = await mintJob(stage, await newConversation());
    const b = await mintJob(stage, await newConversation());
    const asked = await asJob<{ questionId: number }>(
      stage.u.url,
      "PUT",
      "/sandbox/job/question",
      b.token,
      { question: "B's question?", blocking: false },
    );
    expect(asked.status).toBe(200);
    const peek = await asJob<{ status: string }>(
      stage.u.url,
      "GET",
      `/sandbox/job/question/${asked.body.questionId}`,
      a.token,
      { waitMs: 0 },
    );
    expect(peek.status).toBe(200);
    expect(peek.body.status).toBe("unknown");
  });
});

describe("over /mcp", () => {
  test("a job's session lists only the in-sandbox tools, and a person's none of them", async () => {
    const { token } = await mintJob(stage, await newConversation());
    const jobSession = await open(token);
    const jobTools = (
      await mcp(token, jobSession, "tools/list")
    ).body.result?.tools
      ?.map((t) => t.name)
      .sort();
    expect(jobTools).toEqual(
      [...SANDBOX_MCP_TOOL_ACTION_NAMES]
        .map((n) => n.replace(/:/g, "-"))
        .sort(),
    );

    const person = await getMcpAccessToken(
      stage.u.url,
      stage.u.peach.email,
      TEST_PASSWORD,
    );
    const personSession = await open(person);
    const personTools =
      (await mcp(person, personSession, "tools/list")).body.result?.tools?.map(
        (t) => t.name,
      ) ?? [];
    expect(personTools).toContain("bot-list");
    expect(personTools).toContain("sandbox-job-list");
    expect(personTools.some((t) => t.startsWith("sandbox-report"))).toBe(false);
  });

  test("a job's session calling a human tool, or a person calling a sandbox tool, is refused", async () => {
    const { token } = await mintJob(stage, await newConversation());
    const jobSession = await open(token);
    const jobCall = await mcp(token, jobSession, "tools/call", {
      name: "bot-list",
      arguments: { projectId: stage.u.projectId },
    });
    expect(jobCall.body.result?.isError).toBe(true);

    const person = await getMcpAccessToken(
      stage.u.url,
      stage.u.peach.email,
      TEST_PASSWORD,
    );
    const personSession = await open(person);
    const personCall = await mcp(person, personSession, "tools/call", {
      name: "sandbox-report-status",
      arguments: { state: "x", message: "y" },
    });
    expect(personCall.body.result?.isError).toBe(true);
  });

  test("a job's session reports status through its tool", async () => {
    const { job, token } = await mintJob(stage, await newConversation());
    const session = await open(token);
    const res = await mcp(token, session, "tools/call", {
      name: "sandbox-report-status",
      arguments: { state: "testing", message: "Running the tests" },
    });
    expect(res.body.result?.isError ?? false).toBe(false);
    const view = await call<{ sandboxJob: { statusMessage: string } }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/sandbox-job/${job.id}`,
    );
    expect(view.body.sandboxJob.statusMessage).toBe("Running the tests");
  });

  test("a job's session may not hold the GET stream open", async () => {
    const { token } = await mintJob(stage, await newConversation());
    const session = await open(token);
    const res = await fetch(`${stage.u.url}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "mcp-session-id": session,
      },
    });
    expect(res.status).toBe(405);
  });
});
