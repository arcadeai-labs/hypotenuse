import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { NUDGE_TEXT, QUIET_FAILURE } from "../../ops/TickOps";
import { HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  shape,
  startConversation,
} from "./harness";

/**
 * A turn ends only through a terminal tool: a model that stops with text
 * alone is nudged once, and fails the turn if it does it again.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("nudge once, then fail", () => {
  test("text with no tool → one nudge the model sees → it ends its turn", async () => {
    stage.models.play([
      { text: "Hello there!" },
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Hello there!" } },
        ],
        expect: { lastMessageIncludes: "End your turn with" },
      },
    ]);
    const res = await startConversation(stage, "Hi.");
    await runTicks();
    const id = res.body.conversation.id;
    expect(await shape(id)).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "message:assistant",
      "status_change:working→working",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    const { entries } = await readEntries(stage, id);
    expect(entries[4].content).toMatchObject({
      reason: "nudge",
      text: NUDGE_TEXT,
      visibleToModel: true,
    });
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("text twice → the turn fails with the stated reason", async () => {
    stage.models.play([{ text: "Hmm." }, { text: "Still thinking." }]);
    const res = await startConversation(stage, "Hi.");
    await runTicks();
    const id = res.body.conversation.id;
    const row = await conversationRow(id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("failed");
    const { entries } = await readEntries(stage, id);
    const last = entries[entries.length - 1];
    expect(last.kind).toBe("status_change");
    expect(last.content).toMatchObject({
      to: "ended",
      outcome: "failed",
      text: QUIET_FAILURE,
    });
  });

  test("the nudge resets with each turn", async () => {
    stage.models.play([
      { text: "One." },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "One." } }] },
    ]);
    const res = await startConversation(stage, "First.");
    await runTicks();
    stage.models.play([
      { text: "Two." },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Two." } }] },
    ]);
    const { call } = await import("../setup");
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${res.body.conversation.id}/message`,
      { text: "Second." },
    );
    await runTicks();
    expect((await conversationRow(res.body.conversation.id)).state).toBe(
      "hibernating",
    );
  });
});
