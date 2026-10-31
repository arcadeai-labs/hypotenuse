import { describe, expect, test } from "bun:test";
import { draftOf, parseCodeLimits } from "../components/bots/CodeSection";
import { tokenize } from "../components/transcript/CodeRun";

describe("a bot's code-mode limits", () => {
  test("blank fields are the deployment's; filled ones convert to the API's units", () => {
    expect(
      parseCodeLimits({ seconds: "", memoryMiB: "", hostCalls: "" }),
    ).toEqual({});
    expect(
      parseCodeLimits({ seconds: "5", memoryMiB: "32", hostCalls: " 20 " }),
    ).toEqual({
      timeoutMs: 5_000,
      memoryBytes: 32 * 1024 * 1024,
      bridgeRequests: 20,
    });
  });

  test("a bad value is a sentence, not a request", () => {
    expect(
      parseCodeLimits({ seconds: "0", memoryMiB: "", hostCalls: "" }),
    ).toContain("seconds");
    expect(
      parseCodeLimits({ seconds: "", memoryMiB: "4", hostCalls: "" }),
    ).toContain("8 or more");
    expect(
      parseCodeLimits({ seconds: "", memoryMiB: "", hostCalls: "1.5" }),
    ).toContain("whole number");
  });

  test("saved limits read back as the fields that made them", () => {
    const limits = { timeoutMs: 5_000, memoryBytes: 32 * 1024 * 1024 };
    expect(draftOf(limits)).toEqual({
      seconds: "5",
      memoryMiB: "32",
      hostCalls: "",
    });
    expect(parseCodeLimits(draftOf(limits))).toEqual(limits);
  });
});

describe("a program's source in the transcript", () => {
  test("tokens join back to the source, with comments, strings, keywords, and the host API told apart", () => {
    const source =
      '// count\nconst n = await mcp.exec("mail", "read_inbox", { limit: 5 });\nreturn n;';
    const tokens = tokenize(source);
    expect(tokens.map((t) => t.text).join("")).toBe(source);
    const kind = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect(kind("// count")).toBe("comment");
    expect(kind('"mail"')).toBe("string");
    expect(kind("await")).toBe("keyword");
    expect(kind("mcp")).toBe("global");
    expect(kind("5")).toBe("number");
    expect(kind("exec")).toBe("plain");
  });
});
