import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "../../src/acp/connection";
import { THOUGHT_FLUSH_BYTES, TurnMapper } from "../../src/acp/mapping";

/**
 * The ACP → Linear mapping, driven by recorded update sequences with an
 * injected clock. Each test asserts the exact event list.
 */

/** A mapper and its clock. */
function mapper() {
  let now = 1_000;
  const unknown: string[] = [];
  const m = new TurnMapper({
    cwd: "/work",
    now: () => now,
    onUnknown: (kind) => unknown.push(kind),
  });
  return {
    m,
    unknown,
    advance(ms: number) {
      now += ms;
    },
  };
}

const thought = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const message = (text: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  ...(messageId ? { messageId } : {}),
});

describe("mapping", () => {
  test("thoughts are held until 3 s pass, then flushed ephemeral", () => {
    const { m, advance } = mapper();
    expect(m.update(thought("Looking "))).toEqual([]);
    advance(2_999);
    expect(m.tick()).toEqual([]);
    expect(m.update(thought("around."))).toEqual([]);
    advance(1);
    expect(m.tick()).toEqual([
      { type: "thought", body: "Looking around.", ephemeral: true },
    ]);
    expect(m.tick()).toEqual([]);
  });

  test("thoughts flush at 2 KB without waiting", () => {
    const { m } = mapper();
    const big = "x".repeat(THOUGHT_FLUSH_BYTES);
    expect(m.update(thought(big))).toEqual([
      { type: "thought", body: big, ephemeral: true },
    ]);
  });

  test("a buffered thought is flushed before an action, and the last one persists", () => {
    const { m } = mapper();
    m.update(thought("Plan: edit."));
    expect(
      m.update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        status: "pending",
        locations: [{ path: "/work/src/a.ts" }],
      }),
    ).toEqual([
      { type: "thought", body: "Plan: edit.", ephemeral: true },
      {
        type: "action",
        action: "Reading",
        parameter: "src/a.ts",
        ephemeral: true,
      },
    ]);
    m.update(thought("Done reading."));
    m.update(message("All good."));
    expect(m.finish("end_turn", { branch: null })).toEqual([
      { type: "thought", body: "Done reading.", ephemeral: false },
      { type: "response", body: "All good." },
    ]);
  });

  test("tool calls: in progress is ephemeral, completed persists with a result, failed says why", () => {
    const { m } = mapper();
    expect(
      m.update({
        sessionUpdate: "tool_call",
        toolCallId: "x",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
      }),
    ).toEqual([
      {
        type: "action",
        action: "Running",
        parameter: "npm test",
        ephemeral: true,
      },
    ]);
    // An update with no status change produces nothing.
    expect(
      m.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "x",
        content: [
          { type: "content", content: { type: "text", text: "1 passing" } },
        ],
      }),
    ).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "x",
        status: "completed",
      }),
    ).toEqual([
      {
        type: "action",
        action: "Ran",
        parameter: "npm test",
        result: "```\n1 passing\n```",
        ephemeral: false,
      },
    ]);
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "y",
      title: "curl",
      kind: "fetch",
      rawInput: { url: "https://x.test" },
    });
    expect(
      m.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "y",
        status: "failed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "\nECONNREFUSED\nmore" },
          },
        ],
      }),
    ).toEqual([
      {
        type: "action",
        action: "Fetched",
        parameter: "https://x.test",
        result: "Failed: ECONNREFUSED",
        ephemeral: false,
      },
    ]);
  });

  test("an `other` tool reads by its title", () => {
    const { m } = mapper();
    expect(
      m.update({
        sessionUpdate: "tool_call",
        toolCallId: "o",
        title: "Ask the oracle",
        kind: "other",
        rawInput: { q: 1 },
      }),
    ).toEqual([
      {
        type: "action",
        action: "Ask the oracle",
        parameter: '{"q":1}',
        ephemeral: true,
      },
    ]);
  });

  test("plans: the whole list each time, identical plans not re-sent", () => {
    const { m } = mapper();
    const plan: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [
        { content: "A", priority: "high", status: "in_progress" },
        { content: "B", priority: "low", status: "pending" },
      ],
    };
    expect(m.update(plan)).toEqual([
      {
        type: "plan",
        entries: [
          { content: "A", status: "in_progress" },
          { content: "B", status: "pending" },
        ],
      },
    ]);
    expect(m.update(plan)).toEqual([]);
  });

  test("a title becomes one trimmed line of at most 255 characters", () => {
    const { m } = mapper();
    expect(
      m.update({
        sessionUpdate: "session_info_update",
        title: `  Fix\nit ${"y".repeat(300)}`,
      }),
    ).toEqual([{ type: "summary", title: `Fix it ${"y".repeat(247)}…` }]);
    expect(
      m.update({ sessionUpdate: "session_info_update", title: null }),
    ).toEqual([]);
  });

  test("usage is reported for the dashboard", () => {
    const { m } = mapper();
    expect(
      m.update({
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      }),
    ).toEqual([
      { type: "usage", contextUsed: 1200, contextSize: 200000, costUsd: 0.42 },
    ]);
  });

  test("silent kinds produce nothing; an unknown kind is reported once", () => {
    const { m, unknown } = mapper();
    expect(
      m.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    ).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      }),
    ).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
      }),
    ).toEqual([]);
    const odd = { sessionUpdate: "telepathy" } as unknown as SessionUpdate;
    expect(m.update(odd)).toEqual([]);
    expect(m.update(odd)).toEqual([]);
    expect(unknown).toEqual(["telepathy"]);
    expect(m.recorded.mode).toBe("plan");
  });

  test("a replay (session/load) is discarded entirely", () => {
    const { m } = mapper();
    m.replaying = true;
    expect(m.update(message("old answer"))).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "tool_call",
        toolCallId: "z",
        title: "old",
        kind: "read",
      }),
    ).toEqual([]);
    m.replaying = false;
    m.update(message("new answer"));
    expect(m.finish("end_turn", { branch: null })).toEqual([
      { type: "response", body: "new answer" },
    ]);
  });

  test("messages are joined by message id; a silent turn says Done and its last step", () => {
    const { m } = mapper();
    m.update(message("First ", "m1"));
    m.update(message("Second", "m2"));
    m.update(message("part.", "m1"));
    expect(m.finish("end_turn", { branch: null })).toEqual([
      { type: "response", body: "First part.\n\nSecond" },
    ]);
    const quiet = mapper().m;
    quiet.update({
      sessionUpdate: "tool_call",
      toolCallId: "e",
      title: "edit",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/work/x.ts" }],
    });
    expect(quiet.finish("end_turn", { branch: null })).toEqual([
      { type: "response", body: "Done. Last step: Edited x.ts." },
    ]);
  });

  test("stop reasons: refusal, max_tokens, max_turn_requests", () => {
    const refusal = mapper().m;
    expect(refusal.finish("refusal", { branch: null })).toEqual([
      {
        type: "error",
        body: "The agent declined to continue: no reason given",
      },
    ]);
    expect(
      mapper().m.finish("max_tokens", { branch: "hypotenuse/eng-1" }),
    ).toEqual([
      {
        type: "error",
        body: "The agent ran out of output tokens. Progress so far is on `hypotenuse/eng-1`; reply to continue.",
      },
    ]);
    expect(mapper().m.finish("max_turn_requests", { branch: null })).toEqual([
      {
        type: "error",
        body: "The agent hit its per-turn request limit. Reply to continue.",
      },
    ]);
  });

  test("while stopping, only the final response or error may be emitted", () => {
    const { m } = mapper();
    m.stopping = true;
    expect(m.update(thought("late"))).toEqual([]);
    expect(m.flushThought(false)).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "tool_call",
        toolCallId: "s",
        title: "rm",
        kind: "delete",
      }),
    ).toEqual([]);
    expect(
      m.update({
        sessionUpdate: "plan",
        entries: [{ content: "x", priority: "low", status: "pending" }],
      }),
    ).toEqual([]);
    expect(
      m.update({ sessionUpdate: "session_info_update", title: "late" }),
    ).toEqual([]);
  });
});
