import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { conversations } from "../../schema/conversations";
import { costRecords } from "../../schema/cost_records";
import { HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  runTicks,
  startConversation,
} from "./harness";

/**
 * One `cost_records` row per model step, with usage exactly as the provider
 * reported it in its own fields, attributed by copied ids.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("cost records", () => {
  test("one row per step, with the provider's usage", async () => {
    stage.models.play([
      {
        toolCalls: [{ name: "search_history", input: { query: "x" } }],
        usage: { input: 1200, output: 34, cachedInput: 300 },
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "ok" } }],
        usage: { input: 1500, output: 12 },
      },
    ]);
    const res = await startConversation(stage, "Count the cost.");
    await runTicks();
    const id = res.body.conversation.id;
    const rows = await api.db.db
      .select()
      .from(costRecords)
      .where(eq(costRecords.conversationId, id))
      .orderBy(costRecords.id);
    expect(rows).toHaveLength(2);
    const [conversation] = await api.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    for (const row of rows) {
      expect(row).toMatchObject({
        projectId: stage.u.projectId,
        botId: stage.botId,
        channelId: conversation.channelId,
        conversationId: id,
        epoch: 1,
        modelConnectionId: stage.connectionId,
        provider: "anthropic",
        model: "scripted-large",
        costUsd: null,
      });
    }
    // Anthropic reports uncached input apart from cache reads; the AI SDK's
    // input total is their sum, and the cache reads are counted separately.
    expect(rows[0]).toMatchObject({
      inputTokens: 1500,
      outputTokens: 34,
      cachedInputTokens: 300,
    });
    expect(rows[1]).toMatchObject({
      inputTokens: 1500,
      outputTokens: 12,
      cachedInputTokens: 0,
    });
    expect(new Set(rows.map((r) => r.stepId)).size).toBe(2);
  });
});
