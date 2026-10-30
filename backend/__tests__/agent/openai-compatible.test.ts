import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { costRecords } from "../../schema/cost_records";
import { HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  sendMessage,
  shape,
  startConversation,
} from "./harness";

/**
 * The same loop against the OpenAI-compatible Chat Completions API: the real
 * `@ai-sdk/openai-compatible` provider streams from the scripted server, tool
 * calls and results round-trip through hydration, and usage lands in the cost
 * row from that API's own fields.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("openai-compatible");
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

describe("over Chat Completions", () => {
  test("a tool step, reasoning, and a reply, then a second turn that sees them", async () => {
    stage.models.play([
      {
        reasoning: "I should look first.",
        toolCalls: [{ name: "search_history", input: { query: "moon" } }],
        usage: { input: 900, output: 20, cachedInput: 100, reasoning: 7 },
      },
      {
        text: "Found it.",
        toolCalls: [{ name: "reply_and_wait", input: { text: "The moon." } }],
        expect: { lastMessageIncludes: "tool" },
      },
    ]);
    const res = await startConversation(stage, "Where is the moon?");
    await runTicks();
    const id = res.body.conversation.id;
    expect(await shape(id)).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "thinking",
      "message:assistant",
      "tool_call_intent:search_history",
      "tool_result:search_history",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
    const { entries } = await readEntries(stage, id);
    expect(entries[3].content).toMatchObject({
      text: "I should look first.",
      provider: "openai-compatible",
    });
    const [first] = await api.db.db
      .select()
      .from(costRecords)
      .where(eq(costRecords.conversationId, id))
      .orderBy(costRecords.id);
    expect(first).toMatchObject({
      provider: "openai-compatible",
      inputTokens: 900,
      outputTokens: 20,
      cachedInputTokens: 100,
      reasoningTokens: 7,
    });

    stage.models.reset();
    stage.models.play([
      {
        toolCalls: [{ name: "complete", input: { summary: "Done." } }],
        expect: {
          anyMessageIncludes: "The moon.",
          lastMessageIncludes: "Thanks",
        },
      },
    ]);
    await sendMessage(stage, id, "Thanks");
    await runTicks();
    const messages = stage.models.completions[0].body.messages as {
      role: string;
    }[];
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    const row = await conversationRow(id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("completed");
  });
});
