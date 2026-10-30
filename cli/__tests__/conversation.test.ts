import { describe, expect, test } from "bun:test";
import {
  type Entry,
  formatEntry,
  statusText,
} from "../src/commands/conversation";

/**
 * Build an entry with defaults for the fields a test does not care about.
 * @param fields - The fields that matter.
 * @returns The entry.
 */
function entry(fields: Partial<Entry> & Pick<Entry, "kind">): Entry {
  return {
    seq: 1,
    role: null,
    content: {},
    toolName: null,
    interrupted: false,
    createdAt: 0,
    ...fields,
  };
}

/**
 * Strip color, so assertions read the words whatever the terminal.
 * @param text - Possibly colored text.
 * @returns The plain text.
 */
function plain(text: string | null): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes.
  return text === null ? null : text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatEntry", () => {
  test("a person's message and the bot's are labelled, the bot as a bot", () => {
    expect(
      plain(
        formatEntry(
          entry({ kind: "message", role: "user", content: { text: "Hi" } }),
          "Ada",
        ),
      ),
    ).toBe("user: Hi");
    expect(
      plain(
        formatEntry(
          entry({
            kind: "message",
            role: "assistant",
            content: { text: "Hello\nthere" },
          }),
          "Ada",
        ),
      ),
    ).toBe("Ada (bot): Hello\n  there");
  });

  test("a step record — an assistant message with no text — prints nothing", () => {
    expect(
      formatEntry(
        entry({ kind: "message", role: "assistant", content: { text: "" } }),
        "Ada",
      ),
    ).toBeNull();
  });

  test("a speaking tool is what the bot said; any other call is one line", () => {
    expect(
      plain(
        formatEntry(
          entry({
            kind: "tool_call_intent",
            toolName: "reply_and_wait",
            content: { input: { text: "On it" } },
          }),
          "Ada",
        ),
      ),
    ).toBe("Ada (bot): On it");
    expect(
      plain(
        formatEntry(
          entry({
            kind: "tool_call_intent",
            toolName: "ask_question",
            content: { input: { question: "Which?", options: ["a", "b"] } },
          }),
          "Ada",
        ),
      ),
    ).toBe("Ada (bot): Which?\n  options: a | b");
    const line = plain(
      formatEntry(
        entry({
          kind: "tool_call_intent",
          toolName: "search_history",
          content: { input: { query: "x".repeat(500) } },
        }),
        "Ada",
      ),
    );
    expect(line?.startsWith("  → search_history(")).toBe(true);
    expect(line?.includes("\n")).toBe(false);
    expect((line ?? "").length).toBeLessThan(140);
  });

  test("a tool result shows only when it failed or was interrupted", () => {
    expect(
      formatEntry(
        entry({
          kind: "tool_result",
          toolName: "search_history",
          content: { output: { entries: [] } },
        }),
        "Ada",
      ),
    ).toBeNull();
    expect(
      plain(
        formatEntry(
          entry({
            kind: "tool_result",
            toolName: "search_history",
            interrupted: true,
            content: { output: { is_error: true, error_type: "interrupted" } },
          }),
          "Ada",
        ),
      ),
    ).toContain("search_history was interrupted");
    expect(
      plain(
        formatEntry(
          entry({
            kind: "tool_result",
            toolName: "wait_for",
            content: { output: { is_error: true, message: "Too long" } },
          }),
          "Ada",
        ),
      ),
    ).toContain("wait_for failed: Too long");
  });

  test("a status change names both states and why", () => {
    expect(
      plain(
        formatEntry(
          entry({
            kind: "status_change",
            content: { from: "working", to: "hibernating", reason: "reply" },
          }),
          "Ada",
        ),
      ),
    ).toBe("  · working → hibernating (reply)");
  });
});

describe("statusText", () => {
  test("every state reads in words", () => {
    expect(
      plain(statusText({ state: "working", waitingOn: null, outcome: null })),
    ).toContain("Working");
    expect(
      plain(
        statusText({
          state: "waiting",
          waitingOn: { kind: "answer" },
          outcome: null,
        }),
      ),
    ).toContain("Waiting for an answer");
    expect(
      plain(
        statusText({ state: "ended", waitingOn: null, outcome: "completed" }),
      ),
    ).toContain("Complete");
    expect(
      plain(statusText({ state: "ended", waitingOn: null, outcome: "failed" })),
    ).toContain("Failed");
    expect(
      plain(
        statusText({ state: "ended", waitingOn: null, outcome: "cancelled" }),
      ),
    ).toContain("Cancelled");
  });
});
