import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  assemblePrompt,
  contextTerms,
  diffSections,
  extractTerms,
  matchesContext,
  promptHash,
} from "../../ops/PromptOps";
import { fullInputs, goal, section } from "./inputs";

/**
 * The assembler, as a pure function: its fixed order, contextual matching,
 * the budget, goal reviews, and a hash that is the same in any process.
 */

const NOW = new Date("2026-06-01T00:00:00Z");

/**
 * Where each marker first appears in a prompt.
 * @param system - The prompt.
 * @param markers - Strings to find.
 * @returns Their offsets, in the order given.
 */
function offsets(system: string, markers: string[]): number[] {
  return markers.map((m) => {
    const i = system.indexOf(m);
    if (i < 0) throw new Error(`"${m}" is not in the prompt`);
    return i;
  });
}

describe("order", () => {
  test("identity, project, bot, contextual, goals, skills, capabilities, channel, primers, style", () => {
    const { system, sections } = assemblePrompt(fullInputs(), NOW);
    const at = offsets(system, [
      "You are Toadsworth, a bot. The castle steward.",
      "I am the steward.",
      "## House style",
      "## How I work",
      "## Release notes",
      "## Deploys",
      "## Your goals",
      "## Skills",
      "## What your tools can do",
      'over the HTTP API, in the "default" channel',
      "## How you work",
      "## What you remember",
      "## Your tools",
      "## Your own instructions",
      "## Style",
    ]);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(system.startsWith("You are Toadsworth, a bot.")).toBe(true);
    expect(sections.map((s) => s.key)).toEqual([
      "identity",
      "house-style",
      "how-i-work",
      "release-notes",
      "deploys",
    ]);
  });

  test("the Identity section has no heading; every other section does", () => {
    const { system } = assemblePrompt(fullInputs(), NOW);
    expect(system).not.toContain("## Identity");
    expect(system).toContain("## How I work\n\nBriefly.");
  });

  test("goals are active only, by priority, with notes and ids", () => {
    const { system } = assemblePrompt(fullInputs(), NOW);
    const [high, low] = offsets(system, [
      "Goal 8: **Ship the drawbridge** (high priority)",
      "Goal 7: **Keep the moat clean** (low priority)",
    ]);
    expect(high).toBeLessThan(low);
    expect(system).toContain("Notes: Hinges ordered.");
    expect(system).not.toContain("Old goal");
  });

  test("a goal whose review is due asks for one", () => {
    const due = fullInputs({
      goals: [
        goal({
          id: 3,
          title: "Audit the vault",
          reviewEverySeconds: 86_400,
          lastReviewedAt: new Date("2026-05-30T00:00:00Z"),
        }),
        goal({
          id: 4,
          title: "Fresh one",
          reviewEverySeconds: 86_400 * 7,
          lastReviewedAt: new Date("2026-05-30T00:00:00Z"),
        }),
      ],
    });
    const { system } = assemblePrompt(due, NOW);
    expect(system).toContain('Review goal 3 ("Audit the vault")');
    expect(system).not.toContain("Review goal 4");
  });

  test("an empty section, no goals, no skills, and no MCP leave their parts out", () => {
    const { system, sections } = assemblePrompt(
      fullInputs({
        sections: [
          section({ id: 1, key: "identity", body: "Me." }),
          section({ id: 2, body: "  " }),
        ],
        goals: [],
        skills: [],
        mcp: false,
      }),
      NOW,
    );
    expect(sections.map((s) => s.id)).toEqual([1]);
    for (const absent of [
      "## Your goals",
      "## Skills",
      "## Your tools",
      "## What your tools can do",
    ]) {
      expect(system).not.toContain(absent);
    }
  });

  test("the skills index lists arguments, marking optional ones", () => {
    const { system } = assemblePrompt(fullInputs(), NOW);
    expect(system).toContain(
      "- `release-notes` — Write release notes (arguments: since, audience?)",
    );
  });
});

describe("contextual sections", () => {
  test("context terms come from the title, the latest message, and the channel", () => {
    expect(
      contextTerms({
        conversationTitle: "The Drawbridge",
        latestMessage: "How do we deploy it?",
        channel: { type: "api", name: "castle-ops" },
      }),
    ).toEqual(["drawbridge", "deploy", "castle"]);
    expect(extractTerms("what is this about")).toEqual([]);
  });

  test("a keyword matches a term, or the start of one", () => {
    const s = { keywords: ["deploy"], title: "x" };
    expect(matchesContext(s, ["deploying"])).toBe(true);
    expect(matchesContext(s, ["redeploy"])).toBe(false);
    expect(
      matchesContext({ keywords: [], title: "Release notes" }, ["release"]),
    ).toBe(true);
  });

  test("a section whose keywords do not come up is left out", () => {
    const { sections } = assemblePrompt(
      fullInputs({
        latestMessage: "Send the invoices",
        conversationTitle: null,
      }),
      NOW,
    );
    const keys = sections.map((s) => s.key);
    expect(keys).toContain("billing");
    expect(keys).not.toContain("deploys");
    expect(keys).not.toContain("release-notes");
  });
});

describe("the budget", () => {
  test("drops matched contextual sections from the last one back, and records them", () => {
    const base = assemblePrompt(fullInputs(), NOW);
    const deploys = "## Deploys\n\nDeploys go through preprod first.";
    // Just too small for the last contextual section.
    const budget = Math.ceil((base.system.length - deploys.length - 2) / 4);
    const fitted = assemblePrompt(
      fullInputs({ bot: { ...fullInputs().bot, promptBudgetTokens: budget } }),
      NOW,
    );
    expect(fitted.dropped.map((s) => s.key)).toEqual(["deploys"]);
    expect(fitted.sections.map((s) => s.key)).toContain("release-notes");
    expect(fitted.system).not.toContain("## Deploys");
    expect(fitted.overBudget).toBe(false);
  });

  test("never drops an always section; over budget is reported instead", () => {
    const tiny = assemblePrompt(
      fullInputs({ bot: { ...fullInputs().bot, promptBudgetTokens: 10 } }),
      NOW,
    );
    expect(tiny.dropped.map((s) => s.key)).toEqual([
      "release-notes",
      "deploys",
    ]);
    expect(tiny.sections.map((s) => s.key)).toEqual([
      "identity",
      "house-style",
      "how-i-work",
    ]);
    expect(tiny.overBudget).toBe(true);
  });
});

describe("the hash", () => {
  test("is the sha256 of the text, and changes when a section's version does", () => {
    const a = assemblePrompt(fullInputs(), NOW);
    expect(a.hash).toBe(promptHash(a.system));
    const inputs = fullInputs();
    inputs.sections[1] = { ...inputs.sections[1], version: 2, body: "Slowly." };
    const b = assemblePrompt(inputs, NOW);
    expect(b.hash).not.toBe(a.hash);
    expect(diffSections(a.sections, b.sections)).toEqual({
      added: [],
      removed: [],
      changed: [{ id: 2, key: "how-i-work", version: 2, previousVersion: 1 }],
    });
  });

  test("is the same in another process", async () => {
    const here = assemblePrompt(fullInputs(), NOW).hash;
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "hash-of.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out.trim()).toBe(here);
  });
});
