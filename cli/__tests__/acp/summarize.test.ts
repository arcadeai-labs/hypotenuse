import { describe, expect, test } from "bun:test";
import {
  capResult,
  compactParameter,
  compactResult,
  diffStat,
  RESULT_MAX,
  redact,
  type ToolCallState,
  verb,
} from "../../src/acp/summarize";

/** Parameter and result compaction, the diff summary, the cap, and redaction. */

/**
 * A tool call.
 * @param over - Fields to set.
 * @returns The call.
 */
function call(over: Partial<ToolCallState>): ToolCallState {
  return {
    toolCallId: "t",
    title: "",
    kind: null,
    status: "completed",
    rawInput: undefined,
    rawOutput: undefined,
    content: [],
    locations: [],
    ...over,
  };
}

describe("summarize", () => {
  test("verbs by kind, in progress and done; other is the title", () => {
    expect(verb({ kind: "execute", title: "x" }, false)).toBe("Running");
    expect(verb({ kind: "execute", title: "x" }, true)).toBe("Ran");
    expect(verb({ kind: "search", title: "x" }, true)).toBe("Searched");
    expect(verb({ kind: "other", title: "Query the DB" }, true)).toBe(
      "Query the DB",
    );
    expect(verb({ kind: null, title: "" }, false)).toBe("Tool call");
  });

  test("parameters: worktree-relative paths, commands, queries, else JSON", () => {
    expect(
      compactParameter(
        call({ kind: "edit", locations: [{ path: "/w/src/a.ts" }] }),
        "/w",
      ),
    ).toBe("src/a.ts");
    expect(
      compactParameter(
        call({ kind: "read", locations: [{ path: "/elsewhere/b.ts" }] }),
        "/w",
      ),
    ).toBe("/elsewhere/b.ts");
    expect(
      compactParameter(
        call({ kind: "execute", rawInput: { command: ["git", "status"] } }),
        "/w",
      ),
    ).toBe("git status");
    expect(
      compactParameter(
        call({ kind: "execute", rawInput: { command: "x".repeat(300) } }),
        "/w",
      ),
    ).toHaveLength(200);
    expect(
      compactParameter(
        call({ kind: "search", rawInput: { pattern: "TODO" } }),
        "/w",
      ),
    ).toBe("TODO");
    expect(
      compactParameter(call({ kind: "think", rawInput: { a: 1 } }), "/w"),
    ).toBe('{"a":1}');
    expect(
      compactParameter(call({ kind: "think", title: "Ponder" }), "/w"),
    ).toBe("Ponder");
  });

  test("LC-ACT-12 a diff is summarized as +added −removed, with the diff folded", () => {
    expect(diffStat("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
      added: 2,
      removed: 1,
    });
    expect(diffStat(null, "new\nfile\n")).toEqual({ added: 2, removed: 0 });
    expect(
      compactResult(
        call({
          content: [
            { type: "diff", path: "/w/x.ts", oldText: "a\n", newText: "b\n" },
          ],
        }),
        "/w",
      ),
    ).toBe("+1 −1 in x.ts\n\n+++ Diff\n```diff\n-a\n+b\n```\n+++");
  });

  test("text output keeps its last 20 lines", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const result = compactResult(
      call({ content: [{ type: "content", content: { type: "text", text } }] }),
      "/w",
    );
    expect(result).toBe(
      `\`\`\`\n${Array.from({ length: 20 }, (_, i) => `line ${i + 11}`).join("\n")}\n\`\`\``,
    );
    expect(compactResult(call({ rawOutput: { stdout: "ok" } }), "/w")).toBe(
      "```\nok\n```",
    );
    expect(compactResult(call({}), "/w")).toBeUndefined();
  });

  test("LC-ACT-12 results are capped at 2 KB with fences and sections closed", () => {
    const huge = `+1 −0 in big.ts\n\n+++ Diff\n\`\`\`diff\n${"+line\n".repeat(1000)}\`\`\`\n+++`;
    const capped = capResult(huge);
    expect(capped.length).toBeLessThanOrEqual(RESULT_MAX);
    expect((capped.match(/```/g) ?? []).length % 2).toBe(0);
    expect((capped.match(/^\+\+\+/gm) ?? []).length % 2).toBe(0);
    expect(capped.endsWith("…")).toBe(true);
  });

  test("redaction covers the common secret shapes", () => {
    expect(
      redact(
        "key sk-abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstuvwxyz0123 xoxb-1234567890-abc Authorization: Bearer abc.def.ghi hyp_rt_abcdefghijklmnopqrstu",
      ),
    ).toBe(
      "key [redacted] [redacted] [redacted] Authorization: Bearer [redacted] [redacted]",
    );
  });
});
