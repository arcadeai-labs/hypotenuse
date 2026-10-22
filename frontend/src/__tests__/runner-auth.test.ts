import { describe, expect, test } from "bun:test";
import { authInstructions } from "../utils/runnerAuth";

const agents = [
  { id: "claude", preset: "claude" },
  { id: "work-codex", preset: "codex" },
  { id: "goose", preset: "goose" },
];

describe("runner auth instructions", () => {
  test("an agent signs in with agents login, and an API key where its preset takes one", () => {
    expect(authInstructions("work-codex", agents)).toMatchObject({
      commands: ["hypotenuse agents login work-codex"],
      note: expect.stringContaining("OPENAI_API_KEY"),
    });
    expect(authInstructions("goose", agents).note).not.toContain("_API_KEY");
  });

  test("GitHub is the GitHub CLI", () => {
    expect(authInstructions("github", agents).commands).toEqual([
      "gh auth login",
      "gh auth setup-git",
    ]);
  });

  test("any other host is git's own credentials", () => {
    const fix = authInstructions("git.acme.dev", agents);
    expect(fix.title).toBe("git.acme.dev");
    expect(fix.note).toContain("SSH key or a credential helper");
  });
});
