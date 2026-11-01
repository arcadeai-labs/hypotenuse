import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStepsPerTurn } from "../components/bots/BudgetSection";
import {
  BOT_SECTIONS,
  DEFAULT_BOT_SECTION,
  findBotSection,
} from "../components/bots/sections";
import {
  BOT_WRITE_DENIED,
  botWriteDenied,
  missingAliasesSentence,
} from "../utils/bots";

describe("who may change a bot", () => {
  test("the action's refusal comes first", () => {
    expect(
      botWriteDenied("Only members of this project can do this.", {
        canWrite: true,
      }),
    ).toBe("Only members of this project can do this.");
  });

  test("the bot's own write list refuses a member who may otherwise edit", () => {
    expect(botWriteDenied(undefined, { canWrite: false })).toBe(
      BOT_WRITE_DENIED,
    );
  });

  test("allowed by both, or standing not known yet, is not a refusal", () => {
    expect(botWriteDenied(undefined, { canWrite: true })).toBeUndefined();
    expect(botWriteDenied(undefined, null)).toBeUndefined();
  });
});

describe("the missing model names banner", () => {
  test("nothing missing says nothing", () => {
    expect(missingAliasesSentence([])).toBeNull();
  });

  test("one or both names, in words", () => {
    expect(missingAliasesSentence(["fast"])).toBe(
      'This project needs the "fast" model name before any bot can run.',
    );
    expect(missingAliasesSentence(["default", "fast"])).toBe(
      'This project needs the "default" and "fast" model names before any bot can run.',
    );
  });
});

describe("steps per turn", () => {
  test("a whole number from 1 to 500, and nothing else", () => {
    expect(parseStepsPerTurn("50")).toBe(50);
    expect(parseStepsPerTurn(" 1 ")).toBe(1);
    expect(parseStepsPerTurn("500")).toBe(500);
    for (const bad of ["", "0", "501", "2.5", "-3", "ten"]) {
      expect(parseStepsPerTurn(bad), bad).toBeNull();
    }
  });
});

describe("the bot page's sections", () => {
  test("every slug is unique, and the default is one of them", () => {
    const slugs = BOT_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(findBotSection(DEFAULT_BOT_SECTION)?.slug).toBe(DEFAULT_BOT_SECTION);
  });

  test("no slug takes the address of a sibling page or the old memory redirect", () => {
    for (const taken of ["prompt", "chat", "conversations", "memory", "new"]) {
      expect(findBotSection(taken)).toBeUndefined();
    }
  });

  test("an unknown slug finds nothing", () => {
    expect(findBotSection("nope")).toBeUndefined();
    expect(findBotSection(undefined)).toBeUndefined();
  });

  test("every card the page used to stack is on exactly one section", () => {
    const source = readFileSync(
      join(import.meta.dir, "../components/bots/sections.tsx"),
      "utf8",
    );
    for (const card of [
      "IdentitySection",
      "AccessSection",
      "ModelSection",
      "PromptSettingsSection",
      "BudgetSection",
      "GoalsSection",
      "SkillsSection",
      "MemorySection",
      "ToolsSection",
      "CodeSection",
      "SandboxSection",
      "ApprovalSettingsSection",
      "ChannelsSection",
      "ListeningSection",
      "CallbackSecretSection",
    ]) {
      expect(source.split(`<${card}`).length - 1, card).toBe(1);
    }
  });
});
