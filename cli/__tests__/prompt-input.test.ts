import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewText } from "../src/commands/goal";
import { loadingText, renderPreview } from "../src/commands/prompt";
import { argsText } from "../src/commands/skill";
import { bodyText, parseArgSpec } from "../src/input";

/**
 * The pure parts of `prompt`, `goal`, and `skill`: how a skill argument is
 * typed, where a body comes from, and how each renders for a person.
 */

describe("parseArgSpec", () => {
  test("name, name! (required), and name=default", () => {
    expect(parseArgSpec("audience")).toEqual({
      name: "audience",
      required: false,
    });
    expect(parseArgSpec("since!")).toEqual({ name: "since", required: true });
    expect(parseArgSpec("audience=the whole team")).toEqual({
      name: "audience",
      required: false,
      default: "the whole team",
    });
    expect(parseArgSpec("x=")).toEqual({
      name: "x",
      required: false,
      default: "",
    });
  });

  test("refuses a bad name, and a required argument with a default", () => {
    expect(() => parseArgSpec("2fast")).toThrow("--arg takes");
    expect(() => parseArgSpec("since!=v1")).toThrow("has no default");
  });
});

describe("bodyText", () => {
  test("--body, --body-file, neither, and not both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyp-body-"));
    const file = join(dir, "body.md");
    writeFileSync(file, "From a file.");
    expect(await bodyText({ body: "Inline." })).toBe("Inline.");
    expect(await bodyText({ bodyFile: file })).toBe("From a file.");
    expect(await bodyText({})).toBeUndefined();
    await expect(bodyText({ body: "a", bodyFile: file })).rejects.toThrow(
      "not both",
    );
  });
});

describe("rendering", () => {
  test("loading, review intervals, and arguments read as a person would say them", () => {
    expect(loadingText({ loading: "always", keywords: [] })).toBe("always");
    expect(
      loadingText({ loading: "contextual", keywords: ["deploy", "ship"] }),
    ).toBe("contextual (deploy, ship)");
    expect(loadingText({ loading: "contextual", keywords: [] })).toBe(
      "contextual (title words)",
    );
    expect(reviewText(null)).toBe("never");
    expect(reviewText(7 * 86_400)).toBe("every 7d");
    expect(reviewText(12 * 3_600)).toBe("every 12h");
    expect(
      argsText([
        { name: "since", required: true },
        { name: "audience", required: false, default: "customers" },
        { name: "tone", required: false },
      ]),
    ).toBe("since!, audience=customers, tone");
    expect(argsText([])).toBe("-");
  });

  test("a preview names the hash, the budget, and what was dropped", () => {
    const text = renderPreview(
      {
        system: "You are Ada.",
        hash: "ab12",
        sections: [
          {
            id: 1,
            key: "identity",
            title: "Identity",
            scope: "bot",
            loading: "always",
            version: 3,
            estimatedTokens: 4,
          },
        ],
        dropped: [
          {
            id: 2,
            key: "deploys",
            title: "Deploys",
            scope: "bot",
            loading: "contextual",
            version: 1,
            estimatedTokens: 900,
          },
        ],
        contextTerms: ["deploy"],
        estimatedTokens: 1_200,
        budgetTokens: 1_000,
        overBudget: true,
        mcp: false,
      },
      true,
    );
    expect(text).toContain("hash      ab12");
    expect(text).toContain("about 1200 of 1000 — over budget");
    expect(text).toContain("sections  identity@3");
    expect(text).toContain("dropped   deploys@1 (over budget)");
    expect(text.endsWith("You are Ada.")).toBe(true);
  });
});
