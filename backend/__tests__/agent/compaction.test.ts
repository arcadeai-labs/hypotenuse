import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api, config } from "keryx";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  drainQueue,
  readEntries,
  runTicks,
  sendMessage,
  startConversation,
} from "./harness";

/**
 * Background compaction: a prompt near the window asks for a summary of the
 * earlier turns, written by the `fast` model as a `compaction` entry;
 * hydration then sends the summary and the tail; nothing is deleted, and
 * `search_history` still finds what the summary replaced.
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

describe("compaction", () => {
  test("the threshold asks for a summary; hydration sends it and the tail; search_history still finds the past", async () => {
    // A 40k window: compaction is due past 7,232 prompt tokens, and a tick
    // waits for it past 23,616.
    config.agents.contextWindowTokens = 40_000;

    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Noted." } }],
        usage: { input: 100 },
      },
    ]);
    const res = await startConversation(
      stage,
      "Remember: the password is swordfish.",
    );
    const id = res.body.conversation.id;
    await runTicks();

    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Sure." } }],
        usage: { input: 30_000 },
      },
    ]);
    await sendMessage(stage, id, "Now something long.");
    await runTicks();
    expect(await api.resque.queue.length("agents")).toBe(1);

    // The next turn must wait: the window is nearly full and a summary is coming.
    await sendMessage(stage, id, "Third: what was the password?");
    const waited = await runAction<{ ended: string }>("agent:tick", {
      conversationId: id,
    });
    expect(waited.ended).toBe("waiting-for-compaction");
    expect(stage.models.completions).toHaveLength(2);

    // The summary is written with the fast model, from everything before the
    // newest turn.
    stage.models.play([
      {
        text: "The person shared a secret word earlier; the bot acknowledged it.",
        expect: { anyMessageIncludes: "swordfish" },
      },
    ]);
    expect(
      await drainQueue("agents", { only: "conversation:compact" }),
    ).toEqual(["conversation:compact"]);
    expect(stage.models.completions[2].body.model).toBe("scripted-small");
    const afterCompaction = await readEntries(stage, id);
    const compaction = afterCompaction.entries.find(
      (e) => e.kind === "compaction",
    );
    expect(compaction).toBeDefined();
    const firstThird = afterCompaction.entries.find(
      (e) => e.content.text === "Third: what was the password?",
    );
    const throughSeq = Number(compaction?.content.throughSeq);
    expect(throughSeq).toBeLessThan(Number(firstThird?.seq));
    expect((await conversationRow(id)).lastInputTokens).toBeNull();

    // The waiting turn goes ahead with the summary in place of the past.
    stage.models.play([
      {
        toolCalls: [{ name: "search_history", input: { query: "swordfish" } }],
        expect: {
          anyMessageIncludes: "Summary of the earlier conversation",
          noMessageIncludes: "swordfish",
        },
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "swordfish" } }],
        expect: { lastMessageIncludes: "swordfish" },
      },
    ]);
    await runAction("agent:tick", { conversationId: id });
    expect((await conversationRow(id)).state).toBe("hibernating");

    // Nothing was deleted.
    const all = await readEntries(stage, id);
    expect(
      all.entries.some(
        (e) => e.content.text === "Remember: the password is swordfish.",
      ),
    ).toBe(true);
    const seqs = all.entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  test("with nothing to cut, the size is forgotten so no tick waits forever", async () => {
    config.agents.contextWindowTokens = 40_000;
    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }],
        usage: { input: 30_000 },
      },
    ]);
    const res = await startConversation(stage, "One long first message.");
    const id = res.body.conversation.id;
    await runTicks();
    // Only one turn: the cut would be before the first message.
    expect(
      await drainQueue("agents", { only: "conversation:compact" }),
    ).toEqual(["conversation:compact"]);
    expect((await conversationRow(id)).lastInputTokens).toBeNull();
    const { entries } = await readEntries(stage, id);
    expect(entries.some((e) => e.kind === "compaction")).toBe(false);
  });
});
