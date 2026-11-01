import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api, config } from "keryx";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  drainQueue,
  readEntries,
  runTicks,
  shape,
  startConversation,
} from "./harness";

/**
 * The tick contract, against the scripted model speaking the Anthropic
 * Messages API (streamed): the exact entry sequence of a turn, tool steps
 * inside one tick, the yield, the per-turn step limit, and hydration.
 */
let stage: AgentStage;
let defaults: typeof config.agents;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.agents };
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  Object.assign(config.agents, defaults);
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A step that only calls `search_history`, a non-terminal tool. */
const lookStep = {
  toolCalls: [{ name: "search_history", input: { query: "castle" } }],
};

describe("a turn", () => {
  test("a scripted reply → reply_and_wait → hibernating, with the exact entry sequence", async () => {
    stage.models.play([
      {
        text: "Let me answer.",
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Hello, Peach." } },
        ],
        expect: {
          lastMessageIncludes: "Hello?",
          systemIncludes: "castle steward",
          toolsOffered: [
            "ask_question",
            "complete",
            "escalate_to_human",
            "fail",
            "goal_list",
            "goal_update",
            "memory_edit",
            "memory_forget",
            "memory_list",
            "memory_read",
            "memory_search",
            "memory_write",
            "mcp_list_tools",
            "prompt_create",
            "prompt_edit",
            "prompt_list",
            "prompt_read",
            "reply_and_wait",
            "run_code",
            "sandbox_start",
            "search_history",
            "skill_list",
            "use_skill",
            "wait_for",
          ],
        },
      },
    ]);
    const res = await startConversation(stage, "Hello?");
    expect(res.status).toBe(200);
    expect(res.body.conversation.state).toBe("working");
    expect(await runTicks()).toBe(1);

    const row = await conversationRow(res.body.conversation.id);
    expect(row.state).toBe("hibernating");
    expect(row.epoch).toBe(1);
    expect(row.leaseOwner).toBeNull();
    expect(row.wakeRequestedAt).toBeNull();
    expect(await shape(row.id)).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    const { entries } = await readEntries(stage, row.id);
    const assistant = entries.find(
      (e) => e.kind === "message" && e.role === "assistant",
    );
    expect(assistant?.content).toMatchObject({ text: "Let me answer." });
    expect(assistant?.inputTokens).toBe(10);
    expect(assistant?.outputTokens).toBe(5);
    expect(assistant?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const intent = entries.find((e) => e.kind === "tool_call_intent");
    expect(intent?.replay).toBe("unsafe");
    expect(intent?.content).toEqual({ input: { text: "Hello, Peach." } });
  });

  test("a tool step then a terminal step run inside one tick", async () => {
    stage.models.play("look-then-reply");
    const res = await startConversation(stage, "Look around the castle.");
    expect(await runTicks()).toBe(1);
    expect(await shape(res.body.conversation.id)).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "message:assistant",
      "tool_call_intent:search_history",
      "tool_result:search_history",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    expect(stage.models.completions).toHaveLength(2);
  });

  test("the second turn hydrates every earlier message, call, and result", async () => {
    stage.models.play([
      lookStep,
      { toolCalls: [{ name: "reply_and_wait", input: { text: "First." } }] },
    ]);
    const res = await startConversation(stage, "The first question.");
    await runTicks();
    stage.models.reset();
    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Second." } }],
        expect: { lastMessageIncludes: "The second question." },
      },
    ]);
    const sent = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${res.body.conversation.id}/message`,
      { text: "The second question." },
    );
    expect(sent.status).toBe(200);
    await runTicks();
    const messages = stage.models.completions[0].body.messages as {
      role: string;
      content: { type: string; name?: string; tool_use_id?: string }[];
    }[];
    // user, assistant(tool_use), user(tool_result), assistant(tool_use
    // reply_and_wait), user(tool_result + the new message).
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const kinds = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.map((c) => c.type) : ["text"],
    );
    expect(kinds.filter((k) => k === "tool_use")).toHaveLength(2);
    expect(kinds.filter((k) => k === "tool_result")).toHaveLength(2);
    const row = await conversationRow(res.body.conversation.id);
    expect(row.epoch).toBe(2);
    expect(row.state).toBe("hibernating");
  });

  test("a changed prompt writes a context_update; an unchanged one does not", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "One." } }] },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Two." } }] },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Three." } }],
        expect: { systemIncludes: "You speak only in rhyme." },
      },
    ]);
    const res = await startConversation(stage, "Hi.");
    const id = res.body.conversation.id;
    await runTicks();
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${id}/message`,
      { text: "Again." },
    );
    await runTicks();
    const edited = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { persona: "You speak only in rhyme." },
    );
    expect(edited.status).toBe(200);
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${id}/message`,
      { text: "And again." },
    );
    await runTicks();
    const updates = (await shape(id)).filter((s) => s === "context_update");
    expect(updates).toHaveLength(2);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { persona: "You are the castle steward. You are brief and kind." },
    );
  });
});

describe("limits", () => {
  test("the maxStepsPerTick yield re-enqueues the tick and leaves the turn unchanged", async () => {
    config.agents.maxStepsPerTick = 2;
    stage.models.play([
      lookStep,
      lookStep,
      lookStep,
      { toolCalls: [{ name: "reply_and_wait", input: { text: "At last." } }] },
    ]);
    const res = await startConversation(stage, "Search three times.");
    const id = res.body.conversation.id;

    // Run exactly one tick.
    expect(
      await drainQueue("agents", { only: "agent:tick", limit: 1 }),
    ).toEqual(["agent:tick"]);
    expect(await api.resque.queue.length("agents")).toBe(1);
    const yielded = await conversationRow(id);
    expect(yielded.state).toBe("working");
    expect(yielded.epoch).toBe(1);
    expect(yielded.stepsThisTurn).toBe(2);
    expect(yielded.leaseOwner).toBeNull();
    expect(yielded.wakeRequestedAt).not.toBeNull();

    expect(await runTicks()).toBeGreaterThanOrEqual(1);
    const done = await conversationRow(id);
    expect(done.state).toBe("hibernating");
    expect(done.stepsThisTurn).toBe(4);
    expect(done.epoch).toBe(1);
  });

  test("bots.maxStepsPerTurn fails the turn, saying how many steps it took", async () => {
    const limited = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { maxStepsPerTurn: 2 },
    );
    expect(limited.status).toBe(200);
    stage.models.play([lookStep, lookStep, lookStep]);
    const res = await startConversation(stage, "Search forever.");
    await runTicks();
    const row = await conversationRow(res.body.conversation.id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("failed");
    const { entries } = await readEntries(stage, row.id);
    const failure = entries[entries.length - 1];
    expect(failure.kind).toBe("status_change");
    expect(String(failure.content.text)).toContain("took 2 model steps");
    expect(stage.models.completions).toHaveLength(2);
    stage.models.reset();
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { maxStepsPerTurn: 50 },
    );
  });

  test("a model the project lacks fails the turn with what an admin must do", async () => {
    const edited = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/model-alias`,
      {
        name: "missing-later",
        connectionId: stage.connectionId,
        modelId: "scripted-large",
      },
    );
    expect(edited.status).toBe(200);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { modelAlias: "missing-later" },
    );
    const aliases = await call<{
      modelAliases: { id: number; name: string }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/model-aliases`,
    );
    const alias = aliases.body.modelAliases.find(
      (a) => a.name === "missing-later",
    );
    const res = await startConversation(stage, "Think hard.");
    // Point the bot at a name, then remove the alias out from under it, as a
    // row written by hand or a race would.
    const { modelAliases } = await import("../../schema/model_aliases");
    const { eq } = await import("drizzle-orm");
    await api.db.db.delete(modelAliases).where(eq(modelAliases.id, alias!.id));
    await runTicks();
    const row = await conversationRow(res.body.conversation.id);
    expect(row.outcome).toBe("failed");
    const { entries } = await readEntries(stage, row.id);
    expect(String(entries[entries.length - 1].content.text)).toContain(
      'no model named "missing-later"',
    );
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { modelAlias: "default" },
    );
  });
});
