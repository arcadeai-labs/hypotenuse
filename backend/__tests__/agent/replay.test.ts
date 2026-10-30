import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api, config } from "keryx";
import { z } from "zod";
import { registerTool, unregisterTool } from "../../tools/registry";
import type { ToolDefinition } from "../../tools/types";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  setColumns,
  shape,
  startConversation,
  startTick,
  until,
  untilRequests,
} from "./harness";

/**
 * Crash recovery: a model call is replay-safe and re-runs; a tool call with
 * an intent and no result re-runs only if it declares itself safe, and is
 * otherwise reported to the model as interrupted. The worker is "killed" by
 * forcing its lease to expire while a tool is blocked mid-call, then reaping.
 */
let stage: AgentStage;
let defaults: typeof config.agents;

/** Calls of each test tool, and the gate the first call waits on. */
const calls = { effect: 0, lookup: 0 };
let gate: { open: () => void; promise: Promise<void> } = makeGate();

/**
 * A gate a tool call waits on until the test opens it.
 * @returns The gate.
 */
function makeGate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

/**
 * A test tool that blocks on its first call until the gate opens.
 * @param name - The tool's name.
 * @param replay - Whether it declares itself replay-safe.
 * @returns The definition.
 */
function blockingTool(
  name: "effect" | "lookup",
  replay: "safe" | "unsafe",
): ToolDefinition<{ what: string }, { did: string; call: number }> {
  return {
    name: `test_${name}`,
    description: `A test tool (${replay}).`,
    inputSchema: z.object({ what: z.string() }),
    outputSchema: z.object({ did: z.string(), call: z.number() }),
    replay,
    parallelSafe: false,
    available: () => true,
    run: async (input) => {
      const call = ++calls[name];
      if (call === 1) await gate.promise;
      return { did: input.what, call };
    },
  };
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.agents };
  registerTool(blockingTool("effect", "unsafe"));
  registerTool(blockingTool("lookup", "safe"));
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  Object.assign(config.agents, defaults);
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
  calls.effect = 0;
  calls.lookup = 0;
  gate = makeGate();
});

afterAll(async () => {
  unregisterTool("test_effect");
  unregisterTool("test_lookup");
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("a model call is replay-safe", () => {
  test("the server drops mid-stream → the step re-runs, and there is one assistant entry", async () => {
    config.agents.modelRetryBaseMs = 5;
    stage.models.play([
      {
        text: "This reply is cut short somewhere in the middle.",
        toolCalls: [{ name: "reply_and_wait", input: { text: "lost" } }],
        dropAfter: 3,
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Whole." } }] },
    ]);
    const res = await startConversation(stage, "Hello?");
    await runTicks();
    const id = res.body.conversation.id;
    expect(stage.models.completions).toHaveLength(2);
    const assistants = (await shape(id)).filter(
      (s) => s === "message:assistant",
    );
    expect(assistants).toHaveLength(1);
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("429 and 529 are retried; a 400 fails the turn at once", async () => {
    config.agents.modelRetryBaseMs = 5;
    stage.models.play([
      { fail: { status: 429 } },
      { fail: { status: 529 } },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Third time." } }],
      },
    ]);
    const ok = await startConversation(stage, "Hello?");
    await runTicks();
    expect((await conversationRow(ok.body.conversation.id)).state).toBe(
      "hibernating",
    );
    expect(stage.models.completions).toHaveLength(3);

    stage.models.reset();
    stage.models.play([{ fail: { status: 400, message: "bad request" } }]);
    const bad = await startConversation(stage, "Hello?");
    await runTicks();
    const row = await conversationRow(bad.body.conversation.id);
    expect(row.outcome).toBe("failed");
    expect(stage.models.completions).toHaveLength(1);
    const { entries } = await readEntries(stage, row.id);
    expect(String(entries[entries.length - 1].content.text)).toContain(
      "The model refused the request",
    );
  });

  test("a provider that keeps failing fails the turn after the configured attempts", async () => {
    config.agents.modelRetryBaseMs = 5;
    config.agents.modelAttempts = 2;
    stage.models.play([{ fail: { status: 500 } }, { fail: { status: 500 } }]);
    const res = await startConversation(stage, "Hello?");
    await runTicks();
    const row = await conversationRow(res.body.conversation.id);
    expect(row.outcome).toBe("failed");
    const { entries } = await readEntries(stage, row.id);
    expect(String(entries[entries.length - 1].content.text)).toContain(
      "could not be reached after 2 attempts",
    );
  });
});

/**
 * Start a conversation whose first step calls a blocking test tool, run the
 * tick until the tool is blocked, then kill the worker: expire its lease and
 * reap. Returns the first tick (still blocked) and the conversation id.
 * @param tool - Which test tool.
 * @param next - The scripted steps after recovery.
 * @returns The first tick and the conversation id.
 */
async function killMidCall(
  tool: "test_effect" | "test_lookup",
  next: Parameters<AgentStage["models"]["play"]>[0],
) {
  stage.models.play([
    { toolCalls: [{ name: tool, input: { what: "open the gate" } }] },
    ...(next as never[]),
  ]);
  const res = await startConversation(stage, "Open the gate.");
  const id = res.body.conversation.id;
  const first = startTick(id);
  await until(
    async () =>
      (await shape(id)).includes(`tool_call_intent:${tool}`) &&
      calls[tool === "test_effect" ? "effect" : "lookup"] === 1,
  );
  await setColumns(id, { leaseExpiresAt: new Date(Date.now() - 1000) });
  await runAction("agents:reap");
  return { first, id };
}

describe("an intent with no result", () => {
  test("an unsafe tool is reported interrupted, the model's next request sees it, and the dead tick writes nothing more", async () => {
    const { first, id } = await killMidCall("test_effect", [
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "I could not tell." } },
        ],
        expect: { lastMessageIncludes: "interrupted" },
      },
    ]);
    await runTicks();
    expect(calls.effect).toBe(1);
    const after = await shape(id);
    expect(after).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "message:assistant",
      "tool_call_intent:test_effect",
      "tool_result:test_effect",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    const { entries } = await readEntries(stage, id);
    const result = entries.find(
      (e) => e.toolName === "test_effect" && e.kind === "tool_result",
    );
    expect(result?.interrupted).toBe(true);

    // The dead worker wakes up and finds it no longer owns anything.
    gate.open();
    expect(await first).toMatchObject({ ended: "lease-lost" });
    expect(await shape(id)).toEqual(after);
  });

  test("a safe tool is re-run, and its result is written once", async () => {
    const { first, id } = await killMidCall("test_lookup", [
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Found." } }],
        expect: { lastMessageIncludes: "open the gate" },
      },
    ]);
    await runTicks();
    expect(calls.lookup).toBe(2);
    gate.open();
    expect(await first).toMatchObject({ ended: "lease-lost" });
    const results = (await shape(id)).filter(
      (s) => s === "tool_result:test_lookup",
    );
    expect(results).toHaveLength(1);
    const { entries } = await readEntries(stage, id);
    const result = entries.find(
      (e) => e.toolName === "test_lookup" && e.kind === "tool_result",
    );
    expect(result?.content).toEqual({
      output: { did: "open the gate", call: 2 },
    });
    expect((await conversationRow(id)).state).toBe("hibernating");
  });
});

describe("a recovered terminal call", () => {
  test("a safe terminal call (wait_for) left open re-runs after the step's other calls, then parks", async () => {
    calls.lookup = 1; // the gate is for first calls; this one must not wait
    const { appendEntries } = await import("../../ops/TranscriptOps");
    const res = await startConversation(stage, "Wait a minute.");
    const id = res.body.conversation.id;
    await clearLoopQueues();
    // A tick took a step, recorded the intent, and died before running it.
    const row = await conversationRow(id);
    await api.db.db.transaction((tx) =>
      appendEntries(tx, id, row.epoch, [
        {
          kind: "message",
          role: "assistant",
          stepId: "dead-step",
          content: { text: "" },
        },
        {
          kind: "tool_call_intent",
          role: "assistant",
          stepId: "dead-step",
          toolCallId: "toolu_dead",
          toolName: "wait_for",
          replay: "safe",
          content: { input: { seconds: 60 } },
        },
        // A safe call the model listed after the terminal one.
        {
          kind: "tool_call_intent",
          role: "assistant",
          stepId: "dead-step",
          toolCallId: "toolu_dead_look",
          toolName: "test_lookup",
          replay: "safe",
          content: { input: { what: "the tide" } },
        },
      ]),
    );
    await setColumns(id, {
      leaseOwner: "dead",
      leaseExpiresAt: new Date(Date.now() - 1000),
      wakeRequestedAt: null,
    });
    await runAction("agents:reap");
    expect(await startTick(id)).toMatchObject({ ended: "released", steps: 0 });
    const after = await conversationRow(id);
    expect(after.state).toBe("waiting");
    expect(after.waitingOn?.kind).toBe("timer");
    expect(stage.models.completions).toHaveLength(0);
    // Every intent of the step was settled before it parked, the terminal last.
    const { openIntents } = await import("../../ops/ConversationOps");
    expect(await openIntents(api.db.db, id)).toHaveLength(0);
    const results = (await shape(id)).filter((s) =>
      s.startsWith("tool_result"),
    );
    expect(results).toEqual([
      "tool_result:test_lookup",
      "tool_result:wait_for",
    ]);
  });
});

describe("idempotency keys come from durable ids", () => {
  test("a tool sees hyp-<conversationId>-<toolCallId>", async () => {
    let seen = "";
    registerTool({
      name: "test_key",
      description: "Reports its idempotency key.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      replay: "unsafe",
      parallelSafe: false,
      available: () => true,
      run: async (_input, ctx) => {
        seen = ctx.idempotencyKey;
        return {};
      },
    });
    try {
      stage.models.play([
        { toolCalls: [{ name: "test_key", input: {}, id: "toolu_fixed_1" }] },
        { toolCalls: [{ name: "reply_and_wait", input: { text: "ok" } }] },
      ]);
      const res = await startConversation(stage, "Key?");
      await runTicks();
      expect(seen).toBe(`hyp-${res.body.conversation.id}-toolu_fixed_1`);
    } finally {
      unregisterTool("test_key");
    }
  });
});

describe("the model sees what it did", () => {
  test("a tool's error is data the model reads, never a thrown turn", async () => {
    stage.models.play([
      {
        toolCalls: [
          { name: "wait_for", input: { at: "not a time" } },
          { name: "no_such_tool", input: {} },
        ],
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Sorry." } }],
        expect: { anyMessageIncludes: "unknown_tool" },
      },
    ]);
    const res = await startConversation(stage, "Wait oddly.");
    await runTicks();
    const id = res.body.conversation.id;
    const { entries } = await readEntries(stage, id);
    const result = (name: string) =>
      entries.find((e) => e.kind === "tool_result" && e.toolName === name);
    expect(result("wait_for")?.content.output).toMatchObject({
      is_error: true,
      error_type: "invalid_input",
    });
    expect(result("no_such_tool")?.content.output).toMatchObject({
      is_error: true,
      error_type: "unknown_tool",
    });
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("tool results are scrubbed of credentials before they are stored", async () => {
    registerTool({
      name: "test_leaky",
      description: "Returns a token by mistake.",
      inputSchema: z.object({}),
      outputSchema: z.record(z.string(), z.unknown()),
      replay: "safe",
      parallelSafe: true,
      available: () => true,
      run: async () => ({
        user: "toad",
        nested: { accessToken: "xoxb-secret" },
      }),
    });
    try {
      stage.models.play([
        { toolCalls: [{ name: "test_leaky", input: {} }] },
        {
          toolCalls: [{ name: "reply_and_wait", input: { text: "ok" } }],
          expect: { noMessageIncludes: "xoxb-secret" },
        },
      ]);
      const res = await startConversation(stage, "Leak?");
      await runTicks();
      const { entries } = await readEntries(stage, res.body.conversation.id);
      expect(JSON.stringify(entries)).not.toContain("xoxb-secret");
    } finally {
      unregisterTool("test_leaky");
    }
  });
});

void untilRequests;
