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
import { call, HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  shape,
  startConversation,
  startTick,
  until,
  untilRequests,
} from "./harness";

/**
 * Cancel: a working conversation's tick aborts its model request (the
 * provider sees the disconnect) or its running tool, settles open calls as
 * interrupted, and ends the conversation; a resting or waiting one ends at once.
 */
let stage: AgentStage;
let defaults: typeof config.agents;
let toolAborted = false;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.agents };
  registerTool({
    name: "test_slow",
    description: "Waits until aborted.",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    replay: "unsafe",
    parallelSafe: false,
    available: () => true,
    run: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          toolAborted = true;
          reject(ctx.signal.reason);
        });
      }),
  });
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  Object.assign(config.agents, defaults);
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  unregisterTool("test_slow");
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Cancel over HTTP.
 * @param id - The conversation.
 * @returns The status and body.
 */
async function cancel(id: number) {
  return call<{ result: string }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/conversation/${id}/cancel`,
  );
}

describe("cancel", () => {
  test("mid-step: the model request is aborted, and the server sees the disconnect", async () => {
    config.agents.heartbeatMs = 25;
    stage.models.play([{ hang: true, text: "never" }]);
    const res = await startConversation(stage, "Think forever.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    expect((await cancel(id)).body.result).toBe("requested");
    expect(await tick).toMatchObject({ ended: "cancelled" });
    await until(() => stage.models.disconnects() >= 1);
    const row = await conversationRow(id);
    expect(row).toMatchObject({
      state: "ended",
      outcome: "cancelled",
      leaseOwner: null,
    });
    expect((await shape(id)).slice(-1)).toEqual([
      "status_change:working→ended",
    ]);
    // The aborted step stored nothing.
    expect(await shape(id)).not.toContain("message:assistant");
  });

  test("mid-tool: the tool is aborted and its call settled as interrupted", async () => {
    config.agents.heartbeatMs = 25;
    toolAborted = false;
    stage.models.play([{ toolCalls: [{ name: "test_slow", input: {} }] }]);
    const res = await startConversation(stage, "Be slow.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await until(async () =>
      (await shape(id)).includes("tool_call_intent:test_slow"),
    );
    await cancel(id);
    expect(await tick).toMatchObject({ ended: "cancelled" });
    expect(toolAborted).toBe(true);
    const { entries } = await readEntries(stage, id);
    const result = entries.find(
      (e) => e.kind === "tool_result" && e.toolName === "test_slow",
    );
    expect(result?.interrupted).toBe(true);
    expect((await conversationRow(id)).outcome).toBe("cancelled");
  });

  test("while waiting: it ends at once, with no tick", async () => {
    stage.models.play([
      { toolCalls: [{ name: "wait_for", input: { seconds: 600 } }] },
    ]);
    const res = await startConversation(stage, "Wait.");
    const id = res.body.conversation.id;
    await runTicks();
    expect((await conversationRow(id)).state).toBe("waiting");
    expect((await cancel(id)).body.result).toBe("ended");
    expect(await api.resque.queue.length("agents")).toBe(0);
    expect(await conversationRow(id)).toMatchObject({
      state: "ended",
      outcome: "cancelled",
      waitingOn: null,
    });
  });

  test("working with no live lease: it ends in the request", async () => {
    stage.models.play([]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    expect((await cancel(id)).body.result).toBe("ended");
    // The tick that was owed finds nothing to do.
    await runTicks();
    expect(stage.models.completions).toHaveLength(0);
    expect((await conversationRow(id)).outcome).toBe("cancelled");
  });
});
