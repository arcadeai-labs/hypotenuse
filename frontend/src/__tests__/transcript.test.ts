import { describe, expect, test } from "bun:test";
import {
  buildTranscript,
  conversationStateLabel,
  conversationStatus,
  conversationsQuery,
  conversationTitle,
  type Entry,
  lastSeqOf,
  mergeEntries,
  oneLine,
  platformOf,
  statusLine,
} from "../components/transcript/model";

/**
 * A transcript entry with the fields a test does not care about filled in.
 * @param seq - The entry's seq.
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

describe("buildTranscript", () => {
  test("a person's message, the step record, and a reply drawn as the bot speaking", () => {
    const items = buildTranscript(
      [
        entry(1, {
          kind: "message",
          role: "user",
          content: { text: "Refund?" },
          userId: 7,
        }),
        entry(2, {
          kind: "status_change",
          content: { from: "hibernating", to: "working", reason: "message" },
        }),
        // The step record: an assistant message with no text.
        entry(3, {
          kind: "message",
          role: "assistant",
          content: { text: "", model: "m" },
        }),
        entry(4, {
          kind: "tool_call_intent",
          toolName: "reply_and_wait",
          toolCallId: "a",
          content: { input: { text: "**Yes.**" } },
        }),
        entry(5, {
          kind: "tool_result",
          toolName: "reply_and_wait",
          toolCallId: "a",
          content: { output: { posted: true } },
        }),
        entry(6, {
          kind: "status_change",
          content: { from: "working", to: "hibernating", reason: "reply" },
        }),
      ],
      false,
    );
    expect(items.map((i) => i.kind)).toEqual([
      "person",
      "status",
      "bot",
      "status",
    ]);
    expect(items[0]).toMatchObject({ text: "Refund?", userId: 7 });
    expect(items[2]).toMatchObject({
      text: "**Yes.**",
      tool: "reply_and_wait",
    });
    expect(items[3]).toMatchObject({ text: "Resting until someone writes" });
  });

  test("a tool call is one row joining intent and result; an open one runs only while working", () => {
    const intent = entry(1, {
      kind: "tool_call_intent",
      toolName: "search_history",
      toolCallId: "s",
      replay: "safe",
      content: { input: { query: "refund" } },
    });
    expect(buildTranscript([intent], true)[0]).toMatchObject({
      kind: "tool",
      status: "running",
    });
    expect(buildTranscript([intent], false)[0]).toMatchObject({
      status: "unsettled",
    });
    const done = buildTranscript(
      [
        intent,
        entry(2, {
          kind: "tool_result",
          toolCallId: "s",
          content: { output: { hits: [] } },
        }),
      ],
      false,
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      kind: "tool",
      status: "ok",
      input: { query: "refund" },
      output: { hits: [] },
    });
  });

  test("an interrupted or failed terminal call stays a call: nobody can be sure it was posted", () => {
    const items = buildTranscript(
      [
        entry(1, {
          kind: "tool_call_intent",
          toolName: "reply_and_wait",
          toolCallId: "r",
          content: { input: { text: "hi" } },
        }),
        entry(2, {
          kind: "tool_result",
          toolCallId: "r",
          interrupted: true,
          content: { output: { is_error: true, error_type: "interrupted" } },
        }),
        entry(3, {
          kind: "tool_call_intent",
          toolName: "complete",
          toolCallId: "c",
          content: { input: { summary: "done" } },
        }),
        entry(4, {
          kind: "tool_result",
          toolCallId: "c",
          content: { output: { is_error: true, error_type: "invalid" } },
        }),
      ],
      false,
    );
    expect(items.map((i) => [i.kind, "status" in i ? i.status : null])).toEqual(
      [
        ["tool", "interrupted"],
        ["tool", "error"],
      ],
    );
  });

  test("a question, a failure, a note, thinking, a prompt, and a compaction each draw as themselves", () => {
    const items = buildTranscript(
      [
        entry(1, {
          kind: "context_update",
          content: { prompt: "You are Ada." },
        }),
        entry(2, { kind: "thinking", content: { text: "hmm" } }),
        entry(3, {
          kind: "message",
          role: "assistant",
          content: { text: "Let me look." },
        }),
        entry(4, {
          kind: "tool_call_intent",
          toolName: "ask_question",
          toolCallId: "q",
          content: { input: { question: "Which plan?", options: ["A", "B"] } },
        }),
        entry(5, {
          kind: "tool_result",
          toolCallId: "q",
          content: { output: { asked: true, note: "" } },
        }),
        entry(6, {
          kind: "compaction",
          content: { summary: "They asked about refunds.", throughSeq: 5 },
        }),
        entry(7, {
          kind: "tool_call_intent",
          toolName: "fail",
          toolCallId: "f",
          content: { input: { reason: "No access." } },
        }),
        entry(8, {
          kind: "tool_result",
          toolCallId: "f",
          content: { output: { failed: true } },
        }),
      ],
      false,
    );
    expect(items).toMatchObject([
      { kind: "prompt", prompt: "You are Ada." },
      { kind: "thinking", text: "hmm" },
      { kind: "note", text: "Let me look." },
      { kind: "question", question: "Which plan?", options: ["A", "B"] },
      { kind: "compaction", throughSeq: 5 },
      { kind: "bot", tool: "fail", text: "No access." },
    ]);
  });
});

describe("status lines", () => {
  test("every ending reads as words, and a failed turn is the error tone", () => {
    expect(
      statusLine({ to: "ended", reason: "complete", outcome: "completed" }),
    ).toMatchObject({ text: "Ended: completed", tone: "quiet" });
    expect(
      statusLine({
        to: "ended",
        reason: "cancelled",
        outcome: "cancelled",
        text: "The conversation was cancelled.",
      }),
    ).toEqual({ text: "Cancelled", detail: null, tone: "quiet" });
    expect(
      statusLine({
        to: "ended",
        reason: "turn_failed",
        outcome: "failed",
        text: "The model refused.",
      }),
    ).toEqual({
      text: "The turn failed",
      detail: "The model refused.",
      tone: "error",
    });
    expect(
      statusLine({ from: "new", to: "working", reason: "message" }).text,
    ).toBe("Started");
    expect(statusLine({ to: "waiting", reason: "timer" }).text).toBe(
      "Waiting on a timer",
    );
    expect(statusLine({ to: "working", reason: "nudge" }).text).toBe(
      "Nudged to end its turn with a tool",
    );
  });
});

describe("conversation state", () => {
  test("the glyph status and the words follow the server's state, wait, and outcome", () => {
    const cases = [
      [
        { state: "working", waitingOn: null, outcome: null },
        "working",
        "Working",
      ],
      [
        {
          state: "waiting",
          waitingOn: { kind: "timer", at: 1 },
          outcome: null,
        },
        "waiting:timer",
        "Waiting on a timer",
      ],
      [
        {
          state: "waiting",
          waitingOn: { kind: "answer", questionEntryId: 1, timeoutAt: null },
          outcome: null,
        },
        "waiting:answer",
        "Waiting for an answer",
      ],
      [
        { state: "ended", waitingOn: null, outcome: "completed" },
        "ended:complete",
        "Completed",
      ],
      [
        { state: "ended", waitingOn: null, outcome: "cancelled" },
        "ended:cancelled",
        "Cancelled",
      ],
      [
        { state: "hibernating", waitingOn: null, outcome: null },
        "hibernating",
        "Hibernating",
      ],
    ] as const;
    for (const [c, key, label] of cases) {
      const status = conversationStatus(c);
      const flat =
        status.state === "waiting"
          ? `waiting:${status.waitingOn}`
          : status.state === "ended"
            ? `ended:${status.outcome}`
            : status.state;
      expect(flat).toBe(key);
      expect(conversationStateLabel(c)).toBe(label);
    }
  });

  test("a channel type the kit has no chip for reads as the API", () => {
    expect(platformOf("slack")).toBe("slack");
    expect(platformOf("api")).toBe("api");
    expect(platformOf("carrier-pigeon")).toBe("api");
  });
});

describe("following a transcript", () => {
  test("merging a re-read keeps seq order and drops what is already held", () => {
    const held = [entry(1, {}), entry(2, {})];
    expect(mergeEntries(held, [entry(2, {})])).toBe(held);
    expect(
      mergeEntries(held, [entry(4, {}), entry(3, {})]).map((e) => e.seq),
    ).toEqual([1, 2, 3, 4]);
    expect(lastSeqOf([])).toBe(0);
    expect(lastSeqOf([entry(3, {}), entry(9, {})])).toBe(9);
  });

  test("a call's input fits one line", () => {
    expect(oneLine({})).toBe("");
    expect(oneLine({ query: "refund" })).toBe('{"query":"refund"}');
    expect(oneLine({ text: "x".repeat(300) }, 20)).toHaveLength(20);
  });

  test("the list's query names the page, and the bot and state only when set", () => {
    expect(conversationsQuery({}, 1)).toBe("?page=1&limit=25");
    expect(conversationsQuery({ botId: 4, state: "ended" }, 2)).toBe(
      "?page=2&limit=25&botId=4&state=ended",
    );
  });
});

describe("naming a conversation", () => {
  test("its title, else its first message's first line, else its id", () => {
    expect(conversationTitle({ id: 3, title: "Refunds" })).toBe("Refunds");
    expect(conversationTitle({ id: 3, title: null })).toBe("Conversation #3");
    expect(
      conversationTitle({ id: 3, title: null }, [
        entry(1, { kind: "status_change", content: { to: "working" } }),
        entry(2, {
          kind: "message",
          role: "user",
          content: { text: "\n  How long?\nMore" },
        }),
      ]),
    ).toBe("How long?");
  });
});
