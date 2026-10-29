import { describe, expect, test } from "bun:test";
import { UNAVAILABLE_BOT_SECTIONS } from "../components/bots/UnavailableSections";
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

describe("the bot page's sections not built yet", () => {
  test("are the five the page will configure, and name no plan", () => {
    expect(UNAVAILABLE_BOT_SECTIONS.map((s) => s.title)).toEqual([
      "Channels",
      "Tools",
      "Skills",
      "Prompts",
      "Goals",
    ]);
    for (const section of UNAVAILABLE_BOT_SECTIONS) {
      expect(section.purpose).not.toMatch(/phase/i);
    }
  });
});
