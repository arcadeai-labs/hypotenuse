import { describe, expect, test } from "bun:test";
import {
  buildChat,
  type ChatItem,
  conversationViewOf,
  diagnosticsLine,
  hasLive,
  newestWebConversation,
  skillCompletions,
  stepsHref,
  stepsLabel,
} from "../components/chat/model";
import type { Entry } from "../components/transcript/model";

/**
 * A transcript entry with the fields a test does not care about filled in.
 * @param seq - The entry's seq (and id).
 * @param fields - What the test does care about.
 * @returns The entry.
 */
function entry(seq: number, fields: Partial<Entry>): Entry {
  return {
    id: seq,
    conversationId: 1,
    seq,
    epoch: 1,
    stepId: null,
    kind: "message",
    role: null,
    content: {},
    toolCallId: null,
    toolName: null,
    replay: null,
    interrupted: false,
    promptHash: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    userId: null,
    participantId: null,
    createdAt: 1_000 + seq,
    ...fields,
  } as Entry;
}

/**
 * A model step's record: the assistant message carrying its model and usage.
 * @param seq - Its seq.
 * @param stepId - The step.
 * @param text - Text the step wrote, if any.
 * @returns The entry.
 */
function step(seq: number, stepId: string, text = ""): Entry {
  return entry(seq, {
    kind: "message",
    role: "assistant",
    stepId,
    content: { text, model: "scripted-large", alias: "default" },
    promptHash: "3f9a1c2b7d004e11",
    inputTokens: 1200,
    outputTokens: 80,
    durationMs: 2400,
  });
}

/**
 * A tool call: its intent and, unless `result` is null, its result.
 * @param seq - The intent's seq; the result is `seq + 1`.
 * @param stepId - The step that made it.
 * @param toolName - The tool.
 * @param input - Its input.
 * @param result - The output, `"interrupted"`, or `null` for no result yet.
 * @returns The entries.
 */
function call(
  seq: number,
  stepId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: unknown = { ok: true },
): Entry[] {
  const id = `call-${seq}`;
  const intent = entry(seq, {
    kind: "tool_call_intent",
    role: "assistant",
    stepId,
    toolName,
    toolCallId: id,
    content: { input },
  });
  if (result === null) return [intent];
  return [
    intent,
    entry(seq + 1, {
      kind: "tool_result",
      stepId,
      toolName,
      toolCallId: id,
      interrupted: result === "interrupted",
      content: {
        output:
          result === "interrupted"
            ? { is_error: true, error_type: "interrupted" }
            : result,
      },
    }),
  ];
}

/**
 * The items of one kind.
 * @param items - The chat.
 * @param kind - The kind.
 * @returns Those items.
 */
function only<K extends ChatItem["kind"]>(
  items: ChatItem[],
  kind: K,
): Extract<ChatItem, { kind: K }>[] {
  return items.filter((i) => i.kind === kind) as Extract<
    ChatItem,
    { kind: K }
  >[];
}

describe("buildChat: one row per entry kind", () => {
  test("a message from a person is a bubble with their name: a member's user id, or a participant's", () => {
    const items = buildChat([
      entry(1, {
        kind: "message",
        role: "user",
        content: { text: "Hi", source: "user" },
        userId: 7,
      }),
      entry(2, {
        kind: "message",
        role: "user",
        content: { text: "Me too", source: "participant" },
        participantId: 42,
      }),
    ]);
    expect(items).toEqual([
      {
        kind: "person",
        key: "c1",
        seq: 1,
        text: "Hi",
        userId: 7,
        participantId: null,
        createdAt: 1_001,
      },
      {
        kind: "person",
        key: "c2",
        seq: 2,
        text: "Me too",
        userId: null,
        participantId: 42,
        createdAt: 1_002,
      },
    ]);
  });

  test("a message from the system (a timeout, a wake, a help answer) is a centred system line", () => {
    const items = buildChat([
      entry(1, {
        kind: "message",
        role: "user",
        content: { text: "Answer from Grace: ship it", source: "system" },
      }),
    ]);
    expect(items).toEqual([
      {
        kind: "system",
        key: "c1",
        seq: 1,
        text: "Answer from Grace: ship it",
        tone: "quiet",
        createdAt: 1_001,
      },
    ]);
  });

  test("a terminal call with an ok result is a bot bubble with the step's diagnostics; complete and fail add an outcome", () => {
    const items = buildChat([
      step(1, "s1"),
      ...call(2, "s1", "reply_and_wait", { text: "Five days." }),
      step(4, "s2"),
      ...call(5, "s2", "complete", { summary: "Done." }),
      step(7, "s3"),
      ...call(8, "s3", "fail", { reason: "No access." }),
    ]);
    const bots = only(items, "bot");
    expect(bots.map((b) => [b.text, b.tool, b.outcome])).toEqual([
      ["Five days.", "reply_and_wait", null],
      ["Done.", "complete", "completed"],
      ["No access.", "fail", "failed"],
    ]);
    expect(bots[0]?.diagnostics).toEqual({
      alias: "default",
      model: "scripted-large",
      inputTokens: 1200,
      outputTokens: 80,
      durationMs: 2400,
      promptHash: "3f9a1c2b7d004e11",
    });
    // The step that posted a bubble is its diagnostics, not a counted step.
    expect(only(items, "steps")).toEqual([]);
  });

  test("ask_question with an ok result is a question card; only the newest is live", () => {
    const items = buildChat([
      step(1, "s1"),
      ...call(2, "s1", "ask_question", {
        question: "Which region?",
        options: ["EU", "US", 3],
      }),
      entry(4, {
        kind: "message",
        role: "user",
        content: { text: "EU", source: "user" },
        userId: 7,
      }),
      step(5, "s2"),
      ...call(6, "s2", "ask_question", { question: "Which plan?" }),
    ]);
    const questions = only(items, "question");
    expect(
      questions.map((q) => [q.question, q.options, q.latest, q.seq]),
    ).toEqual([
      ["Which region?", ["EU", "US"], false, 2],
      ["Which plan?", [], true, 6],
    ]);
  });

  test("an approval wait is an approval card naming the calls of the step that asked", () => {
    const items = buildChat([
      step(1, "s1"),
      ...call(2, "s1", "mcp_info", { name: "mail/send_email" }),
      step(4, "s2"),
      ...call(5, "s2", "mcp_exec", { name: "mail/send_email", args: {} }, null),
      entry(6, {
        kind: "status_change",
        content: { from: "working", to: "waiting", reason: "approval" },
      }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps", "approval"]);
    expect(only(items, "approval")[0]).toEqual({
      kind: "approval",
      key: "c6",
      seq: 6,
      callEntryIds: [5],
      createdAt: 1_006,
    });
  });

  test("any other tool call, model step, context update, and thinking is counted into the turn's steps line", () => {
    const items = buildChat([
      entry(1, {
        kind: "message",
        role: "user",
        content: { text: "Find it", source: "user" },
        userId: 7,
      }),
      entry(2, {
        kind: "status_change",
        content: { from: "hibernating", to: "working", reason: "message" },
      }),
      entry(3, { kind: "context_update", content: { prompt: "p" } }),
      entry(4, { kind: "thinking", role: "assistant", content: { text: "…" } }),
      step(5, "s1"),
      ...call(6, "s1", "memory_search", { query: "refunds" }),
      step(8, "s2"),
      ...call(9, "s2", "reply_and_wait", { text: "Found it." }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["person", "steps", "bot"]);
    expect(only(items, "steps")[0]).toEqual({
      kind: "steps",
      key: "s3",
      seqs: [3, 4, 5, 6],
      count: 4,
      warning: false,
      running: false,
    });
  });

  test("a terminal call that errored or was interrupted is counted, and the steps line warns", () => {
    const items = buildChat([
      step(1, "s1"),
      ...call(
        2,
        "s1",
        "reply_and_wait",
        { text: "x" },
        { is_error: true, message: "too long" },
      ),
      step(4, "s2"),
      ...call(5, "s2", "complete", { summary: "y" }, "interrupted"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps"]);
    const line = only(items, "steps")[0];
    expect(line?.warning).toBe(true);
    expect(line?.seqs).toEqual([1, 2, 4, 5]);
    expect(only(items, "bot")).toEqual([]);
  });

  test("a compaction is an earlier-messages-summarized divider", () => {
    const items = buildChat([
      entry(1, {
        kind: "compaction",
        content: { summary: "They asked about refunds.", throughSeq: 40 },
      }),
    ]);
    expect(items).toEqual([
      {
        kind: "compaction",
        key: "c1",
        seq: 1,
        summary: "They asked about refunds.",
        throughSeq: 40,
      },
    ]);
  });
});

describe("buildChat: what else a person must see", () => {
  test("a failed turn and a cancellation leave a system line; other state changes draw nothing", () => {
    const items = buildChat([
      entry(1, {
        kind: "status_change",
        content: { from: "new", to: "working", reason: "created" },
      }),
      entry(2, {
        kind: "status_change",
        content: {
          from: "working",
          to: "ended",
          reason: "turn_failed",
          outcome: "failed",
          text: "It stopped without ending its turn.",
        },
      }),
      entry(3, {
        kind: "status_change",
        content: {
          from: "hibernating",
          to: "ended",
          reason: "cancelled",
          outcome: "cancelled",
        },
      }),
    ]);
    expect(only(items, "system").map((s) => [s.text, s.tone])).toEqual([
      ["The turn failed: It stopped without ending its turn.", "error"],
      ["Cancelled", "quiet"],
    ]);
  });

  test("a call with no result spins while the conversation works", () => {
    const entries = [
      step(1, "s1"),
      ...call(2, "s1", "mcp_exec", { name: "x/y" }, null),
    ];
    expect(
      only(buildChat(entries, { working: true }), "steps")[0]?.running,
    ).toBe(true);
    expect(only(buildChat(entries), "steps")[0]?.running).toBe(false);
  });

  test("text a step wrote but no tool posted is a counted step, not a bubble", () => {
    const items = buildChat([
      step(1, "s1", "Let me look."),
      ...call(2, "s1", "memory_search", { query: "q" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps"]);
  });
});

describe("the chat's words and links", () => {
  test("the steps line counts, and opens the transcript at its entries", () => {
    expect(stepsLabel(1)).toBe("Worked through 1 step");
    expect(stepsLabel(4)).toBe("Worked through 4 steps");
    expect(stepsHref(9, [3, 4, 5])).toBe(
      "/conversations/9?view=transcript&seqs=3,4,5",
    );
  });

  test("diagnostics read as one line, leaving out what the step did not record", () => {
    expect(
      diagnosticsLine({
        alias: "default",
        model: "claude-x",
        inputTokens: 1200,
        outputTokens: 80,
        durationMs: 2400,
        promptHash: "3f9a1c2b7d004e11",
      }),
    ).toBe("default (claude-x) · 1,200 in / 80 out · 2.4s · prompt 3f9a1c2b");
    expect(
      diagnosticsLine({
        alias: null,
        model: "m",
        inputTokens: null,
        outputTokens: null,
        durationMs: 450,
        promptHash: null,
      }),
    ).toBe("m · 450ms");
  });

  test("/ completes the bot's skills: prefix matches first, then names containing it", () => {
    const skills = [
      { name: "release-notes", description: "Write release notes" },
      { name: "triage", description: "Triage an issue" },
      { name: "pre-release", description: "Check a release" },
    ];
    expect(skillCompletions("/", skills).map((s) => s.name)).toEqual([
      "release-notes",
      "triage",
      "pre-release",
    ]);
    expect(skillCompletions("/rel", skills).map((s) => s.name)).toEqual([
      "release-notes",
      "pre-release",
    ]);
    expect(skillCompletions("/triage now", skills)).toEqual([]);
    expect(skillCompletions("hello /tri", skills)).toEqual([]);
  });

  test("a bot's chat opens the newest web conversation the viewer started", () => {
    const rows = [
      { id: 5, createdByUserId: 2, channel: { type: "web" } },
      { id: 4, createdByUserId: 1, channel: { type: "api" } },
      { id: 3, createdByUserId: 1, channel: { type: "web" } },
      { id: 2, createdByUserId: 1, channel: { type: "web" } },
    ];
    expect(newestWebConversation(rows, 1)).toBe(3);
    expect(newestWebConversation(rows, 9)).toBeNull();
    expect(newestWebConversation(rows, null)).toBeNull();
  });

  test("a conversation opens as a chat on the web platform and as a transcript elsewhere, unless asked", () => {
    expect(conversationViewOf(null, "web")).toBe("chat");
    expect(conversationViewOf(null, "api")).toBe("transcript");
    expect(conversationViewOf("chat", "webhook")).toBe("chat");
    expect(conversationViewOf("transcript", "web")).toBe("transcript");
    expect(conversationViewOf("nonsense", "web")).toBe("chat");
  });

  test("the live surface shows only when it has something", () => {
    const none = {
      conversationId: 1,
      state: "working",
      lastSeq: 3,
      status: null,
      stream: null,
      plan: null,
    } as Parameters<typeof hasLive>[0];
    expect(hasLive(null)).toBe(false);
    expect(hasLive(none)).toBe(false);
    expect(
      hasLive({
        ...none,
        status: { id: 1, text: "Thinking…", at: 1 },
      } as never),
    ).toBe(true);
  });
});
