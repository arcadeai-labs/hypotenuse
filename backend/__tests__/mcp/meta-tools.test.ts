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
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { bots } from "../../schema/bots";
import { MODEL_KEY, runTicks, startConversation } from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  addServer,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  type McpStage,
  replyStep,
  resultsOf,
  runCapabilities,
} from "./harness";

/**
 * The meta-tools: who is offered them, search ranking, listing, info before
 * exec, the bot's servers as the edge of what it can see, and the generated
 * capabilities in the prompt.
 */
let stage: McpStage;
let mailId: number;
let githubId: number;
let mcpConfig: typeof config.mcp;

const BUILT_IN = [
  "ask_question",
  "complete",
  "escalate_to_human",
  "fail",
  "memory_edit",
  "memory_forget",
  "memory_list",
  "memory_read",
  "memory_search",
  "memory_write",
  "reply_and_wait",
  "search_history",
  "wait_for",
  "prompt_list",
  "prompt_read",
  "prompt_edit",
  "prompt_create",
  "goal_list",
  "goal_update",
  "skill_list",
  "use_skill",
  "run_code",
  "mcp_list_tools",
];
const MCP_TOOLS = ["mcp_exec", "mcp_info", "mcp_search", "read_large_result"];

beforeAll(async () => {
  stage = await buildMcpStage();
  mailId = (await addServer(stage)).id;
  githubId = (await addServer(stage, { name: "github" })).id;
  mcpConfig = { ...config.mcp };
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  stage.fixture.reset();
  Object.assign(config.mcp, mcpConfig);
  await api.db.db.delete(botMcpServers);
  await api.db.db
    .update(bots)
    .set({ capabilities: null, capabilitiesHash: null });
});

afterAll(async () => {
  await stage.fixture.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run one conversation of scripted steps and return it.
 * @param steps - The steps.
 * @returns The conversation id.
 */
async function run(steps: unknown[]): Promise<number> {
  stage.models.play(steps as never);
  const id = (await startConversation(stage, "Go")).body.conversation.id;
  await runTicks();
  return id;
}

describe("who sees the meta-tools", () => {
  test("a bot with no MCP server is offered only mcp_list_tools", async () => {
    await run([{ ...replyStep(), expect: { toolsOffered: BUILT_IN } }]);
  });

  test("mcp_list_tools tells a bot with no MCP server it has none", async () => {
    const id = await run([
      { toolCalls: [{ name: "mcp_list_tools", input: {} }] },
      { toolCalls: [{ name: "mcp_list_tools", input: { server: "mail" } }] },
      replyStep(),
    ]);
    const [all, one] = await resultsOf(id, "mcp_list_tools");
    expect(all).toMatchObject({
      server: null,
      servers: [],
      total: 0,
      tools: [],
      nextOffset: null,
    });
    expect((all as { note: string }).note).toContain("no MCP servers");
    expect(one).toMatchObject({ is_error: true, error_type: "not_found" });
  });

  test("a bot with a server is, with the tools section in its prompt", async () => {
    await bindServer(stage, mailId);
    await run([
      {
        ...replyStep(),
        expect: {
          toolsOffered: [...BUILT_IN, ...MCP_TOOLS],
          systemIncludes: "mcp_info` on the tool you choose",
        },
      },
    ]);
  });

  test("a disabled server is invisible, and with it the tools", async () => {
    await bindServer(stage, mailId);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/mcp-server/${mailId}`,
      { enabled: false },
    );
    await run([{ ...replyStep(), expect: { toolsOffered: BUILT_IN } }]);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/mcp-server/${mailId}`,
      { enabled: true },
    );
  });
});

describe("search, list, info", () => {
  test("search ranks the right tool first, and says whether it would wait", async () => {
    await bindServer(stage, mailId, { allowedTools: ["mail/read_inbox"] });
    const id = await run([
      // One per step: parallel-safe calls finish in any order.
      {
        toolCalls: [
          { name: "mcp_search", input: { query: "send an email message" } },
        ],
      },
      {
        toolCalls: [
          {
            name: "mcp_search",
            input: { query: "upcoming meetings on my calendar" },
          },
        ],
      },
      {
        toolCalls: [{ name: "mcp_search", input: { query: "read my inbox" } }],
      },
      replyStep(),
    ]);
    const [email, calendar, inbox] = (await resultsOf(id, "mcp_search")) as {
      tools: { name: string; needsApproval: boolean }[];
      searchedBy: string;
    }[];
    expect(email.tools[0].name).toBe("mail/send_email");
    expect(email.tools[0].needsApproval).toBe(true);
    expect(email.searchedBy).toBe("keyword");
    expect(calendar.tools[0].name).toBe("mail/list_calendar_events");
    expect(inbox.tools[0]).toEqual(
      expect.objectContaining({
        name: "mail/read_inbox",
        needsApproval: false,
      }),
    );
  });

  test("a server the bot was not given is invisible to search, list, info, and exec", async () => {
    await bindServer(stage, mailId);
    const id = await run([
      {
        toolCalls: [
          {
            name: "mcp_search",
            input: { query: "open a github pull request" },
          },
          { name: "mcp_list_tools", input: { server: "github" } },
          { name: "mcp_info", input: { name: "github/create_pull_request" } },
        ],
      },
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: { name: "github/create_pull_request", args: {} },
          },
        ],
      },
      replyStep(),
    ]);
    const [search] = (await resultsOf(id, "mcp_search")) as {
      tools: { name: string }[];
    }[];
    expect(search.tools.every((t) => t.name.startsWith("mail/"))).toBe(true);
    for (const tool of ["mcp_list_tools", "mcp_info", "mcp_exec"]) {
      const [out] = await resultsOf(id, tool);
      expect(out, tool).toMatchObject({
        is_error: true,
        error_type: "not_found",
      });
    }
    expect(stage.fixture.calls).toEqual([]);
    expect(githubId).toBeGreaterThan(0);
  });

  test("list with no server lists every server's tools in one call", async () => {
    await bindServer(stage, mailId);
    await bindServer(stage, githubId);
    const id = await run([
      { toolCalls: [{ name: "mcp_list_tools", input: {} }] },
      replyStep(),
    ]);
    const [all] = (await resultsOf(id, "mcp_list_tools")) as {
      server: string | null;
      servers: { name: string; tools: number }[];
      total: number;
      tools: { name: string }[];
      note?: string;
    }[];
    expect(all.server).toBeNull();
    expect(all.servers.map((s) => s.name).sort()).toEqual(["github", "mail"]);
    expect(all.total).toBe(all.servers.reduce((n, s) => n + s.tools, 0));
    expect(all.tools.length).toBe(all.total);
    const prefixes = new Set(all.tools.map((t) => t.name.split("/")[0]));
    expect([...prefixes].sort()).toEqual(["github", "mail"]);
    expect(all.note).toBeUndefined();
  });

  test("list pages one server's tools", async () => {
    await bindServer(stage, mailId);
    const id = await run([
      {
        toolCalls: [
          { name: "mcp_list_tools", input: { server: "mail", limit: 3 } },
        ],
      },
      {
        toolCalls: [
          { name: "mcp_list_tools", input: { server: "mail", offset: 6 } },
        ],
      },
      replyStep(),
    ]);
    const [first, last] = (await resultsOf(id, "mcp_list_tools")) as {
      total: number;
      tools: unknown[];
      nextOffset: number | null;
    }[];
    expect(first).toMatchObject({ total: 7, nextOffset: 3 });
    expect(first.tools.length).toBe(3);
    expect(last).toMatchObject({ nextOffset: null });
    expect(last.tools.length).toBe(1);
  });

  test("mcp_exec without mcp_info is refused with a hint, and nothing is sent", async () => {
    await bindServer(stage, mailId, { allowedTools: ["mail/*"] });
    const id = await run([
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: {
              name: "mail/send_email",
              args: { to: "toad", subject: "x" },
            },
          },
        ],
      },
      replyStep(),
    ]);
    const [out] = await resultsOf(id, "mcp_exec");
    expect(out).toMatchObject({ error_type: "info_required" });
    expect(String(out.next_action_hint)).toContain("mcp_info");
    expect(stage.fixture.calls).toEqual([]);
  });

  test("info returns the schema and annotations; then exec runs, and a server error reads as one", async () => {
    await bindServer(stage, mailId, { allowedTools: ["mail/*"] });
    const id = await run([
      { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
      {
        toolCalls: [{ name: "mcp_info", input: { name: "mail/always_fails" } }],
      },
      {
        toolCalls: [
          {
            name: "mcp_exec",
            input: {
              name: "mail/send_email",
              args: { to: "toad", subject: "x" },
            },
          },
          { name: "mcp_exec", input: { name: "mail/always_fails" } },
        ],
      },
      replyStep(),
    ]);
    const [info] = await resultsOf(id, "mcp_info");
    expect(info).toMatchObject({
      name: "mail/send_email",
      inputSchema: { required: ["to", "subject"] },
      needsApproval: false,
    });
    const [sent, failed] = await resultsOf(id, "mcp_exec");
    expect(sent).toEqual({ name: "mail/send_email", text: "sent to toad" });
    expect(failed).toMatchObject({ error_type: "tool_error" });
    expect(String(failed.message)).toContain("on fire");
  });
});

describe("hybrid search", () => {
  test("with an embedding model, search fuses semantic ranks, and tool vectors are cached", async () => {
    const created = await call<{ modelConnection: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/model-connection`,
      {
        name: "Embeddings",
        provider: "openai-compatible",
        baseUrl: stage.models.baseUrl("openai-compatible"),
        apiKey: MODEL_KEY,
      },
    );
    const alias = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/model-alias`,
      {
        name: "embedding",
        kind: "embedding",
        connectionId: created.body.modelConnection.id,
        modelId: "scripted-embed",
      },
    );
    expect(alias.status).toBe(200);
    await bindServer(stage, mailId);
    // Redis outlives the test database, and ids restart: forget cached vectors.
    const keys = await api.redis.redis.keys("hyp:mcp-embed:*");
    if (keys.length) await api.redis.redis.del(...keys);
    const before = stage.models.embedded.length;
    const id = await run([
      {
        toolCalls: [{ name: "mcp_search", input: { query: "send an email" } }],
      },
      {
        toolCalls: [{ name: "mcp_search", input: { query: "send an email" } }],
      },
      replyStep(),
    ]);
    const [first, second] = (await resultsOf(id, "mcp_search")) as {
      tools: { name: string }[];
      searchedBy: string;
    }[];
    expect(first.searchedBy).toBe("keyword+semantic");
    expect(first.tools[0].name).toBe("mail/send_email");
    expect(second.tools[0].name).toBe("mail/send_email");
    // Seven tool texts and the query the first time; only the query after.
    const embedded = stage.models.embedded.filter((t) =>
      t.includes("send an email"),
    );
    expect(embedded.length).toBe(2);
    expect(stage.models.embedded.length - before).toBe(7 + 2);
  });
});

describe("capabilities", () => {
  test("generated by the fast model when the catalog changes, without tool names, and in the prompt", async () => {
    await bindServer(stage, mailId);
    stage.models.play([
      {
        text: "- Read and send email (send_email)\n- Read calendars",
        expect: { systemIncludes: "Never write a tool's name" },
      },
    ]);
    await runCapabilities();
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, stage.botId));
    expect(bot.capabilities).toBe(
      "- Read and send email (a tool)\n- Read calendars",
    );
    // Nothing changed: no second generation.
    await bindServer(stage, mailId, { allowedTools: ["mail/*"] });
    await runCapabilities();
    expect(stage.models.pending()).toBe(0);

    await run([
      { ...replyStep(), expect: { systemIncludes: "- Read calendars" } },
    ]);
  });

  test("off, the summary is each server and its tool count; with no servers, none", async () => {
    config.mcp.generateCapabilities = false;
    await bindServer(stage, mailId);
    await runCapabilities();
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, stage.botId));
    expect(bot.capabilities).toBe("- mail: 7 tools");
    const removed = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `/project/${stage.u.projectId}/bot/${stage.botId}/mcp-server/${mailId}`,
    );
    expect(removed.status).toBe(200);
    await runCapabilities();
    const [after] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, stage.botId));
    expect(after.capabilities).toBeNull();
  });
});
