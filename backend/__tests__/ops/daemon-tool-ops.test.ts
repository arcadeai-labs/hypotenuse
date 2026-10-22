import { describe, expect, test } from "bun:test";
import { ancestorIds } from "../../ops/DaemonScopeOps";
import { urlOnRepository } from "../../ops/DaemonToolOps";
import {
  bodyForLinear,
  byteLength,
  capDescription,
  capResult,
  DESCRIPTION_MAX_BYTES,
  TRUNCATED_NOTE,
} from "../../ops/LinearMarkdownOps";

/**
 * The pure parts of the agent tools: size caps, NUL stripping, the pull
 * request URL rule, and how far `managed` follows parents.
 */

describe("results and bodies are kept to size", () => {
  test("a result is cut at a line boundary, with the note", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const cut = capResult(text, 1000);
    expect(byteLength(cut)).toBeLessThanOrEqual(1000);
    expect(cut.endsWith(`\n${TRUNCATED_NOTE}`)).toBe(true);
    const kept = cut.slice(0, -TRUNCATED_NOTE.length - 1).split("\n");
    expect(kept.every((l) => /^line \d+$/.test(l))).toBe(true);
    expect(capResult("short")).toBe("short");
  });

  test("a multi-byte character is never split", () => {
    const cut = capResult("é".repeat(5000), 1001);
    expect(cut).not.toContain("�");
    expect(byteLength(cut)).toBeLessThanOrEqual(1001);
  });

  test("a long description points at the issue", () => {
    const cut = capDescription(
      "a\n".repeat(10_000),
      "https://linear.app/x/ENG-1",
    );
    expect(byteLength(cut)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(cut).toEndWith("the rest is at https://linear.app/x/ENG-1)");
  });

  test("a body loses its NUL bytes and is refused over 64 KB or empty", () => {
    expect(bodyForLinear("a\0b", "The comment")).toBe("ab");
    expect(() => bodyForLinear("x".repeat(65_537), "The comment")).toThrow(
      "65537 bytes",
    );
    expect(() => bodyForLinear("\0", "The comment")).toThrow("is empty");
  });
});

describe("a pull request URL must be on the session's repository", () => {
  test.each([
    ["https://github.com/acme/web/pull/7", true],
    ["https://GitHub.com/Acme/Web/pull/7", true],
    ["https://github.com/acme/web", false],
    ["https://github.com/acme/web-old/pull/7", false],
    ["https://github.com/other/lib/pull/1", false],
    ["https://gitlab.com/acme/web/-/merge_requests/1", false],
    ["ftp://github.com/acme/web/pull/7", false],
    ["not a url", false],
  ])("%s → %p", (url, ok) => {
    expect(urlOnRepository(url, "github.com/acme/web")).toBe(ok);
  });

  test("a nested GitLab group works", () => {
    expect(
      urlOnRepository(
        "https://gitlab.com/acme/platform/web/-/merge_requests/3",
        "gitlab.com/acme/platform/web",
      ),
    ).toBe(true);
  });
});

test("managed follows at most five levels of parents", () => {
  let chain = null as { id: string; parent: unknown } | null;
  for (let i = 7; i >= 1; i--) chain = { id: `p${i}`, parent: chain };
  expect(ancestorIds(chain as never)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  expect(ancestorIds(null)).toEqual([]);
});
