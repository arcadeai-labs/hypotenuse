import { describe, expect, test } from "bun:test";
import {
  describeMatch,
  draftFromRule,
  EMPTY_RULE_DRAFT,
  matchFromDraft,
  moveRule,
  settingsFromTimers,
  splitList,
  timersFromSettings,
} from "../components/settings/routing";
import { SETTINGS_SECTIONS } from "../components/settings/sections";

// The routing section's pure half. There is no render harness in this suite
// (see settings-sections.test.ts), so what the form sends and how a rule
// reads are asserted here.

describe("the routing rule form", () => {
  test("an empty form matches every session", () => {
    expect(matchFromDraft(EMPTY_RULE_DRAFT)).toEqual({});
    expect(describeMatch({})).toBe("every session");
  });

  test("only filled fields reach the match, lists split and trimmed", () => {
    expect(
      matchFromDraft({
        ...EMPTY_RULE_DRAFT,
        labels: " PRD, spec ,, ",
        teamKeys: "ENG",
        promptPrefix: " /manage ",
        hasParent: "false",
        origin: "mention",
      }),
    ).toEqual({
      labels: ["PRD", "spec"],
      teamKeys: ["ENG"],
      promptPrefix: "/manage",
      hasParent: false,
      origin: "mention",
    });
    expect(splitList("")).toEqual([]);
  });

  test("a rule round-trips through its draft", () => {
    const rule = {
      name: "PRDs",
      role: "manager" as const,
      match: {
        labels: ["PRD"],
        hasParent: true,
        origin: "delegation" as const,
      },
      repository: "github.com/acme/web",
      enabled: false,
    };
    const draft = draftFromRule(rule);
    expect(draft.repository).toBe("github.com/acme/web");
    expect(draft.enabled).toBe(false);
    expect(matchFromDraft(draft)).toEqual(rule.match);
  });

  test("a match reads as one line", () => {
    expect(
      describeMatch({ promptPrefix: "/manage", labels: ["PRD", "spec"] }),
    ).toBe("starts with /manage · labels PRD or spec");
    expect(describeMatch({ teamKeys: ["ENG"], hasParent: true })).toBe(
      "team ENG · sub-issues",
    );
  });
});

describe("reordering", () => {
  test("moves swap neighbours and never leave the list", () => {
    expect(moveRule([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveRule([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveRule([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moveRule([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(moveRule([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });
});

describe("routing timers", () => {
  const defaults = {
    queueTimeoutMs: 1_800_000,
    stickyTimeoutMs: 600_000,
    offerTtlMs: 10_000,
    repositoryConfidence: 0.7,
    stopGraceMs: 30_000,
  };

  test("the defaults read in minutes and seconds, and round-trip", () => {
    const draft = timersFromSettings(defaults);
    expect(draft.queueTimeoutMinutes).toBe("30");
    expect(draft.offerTtlSeconds).toBe("10");
    expect(settingsFromTimers(draft)).toEqual({ routing: defaults });
  });

  test("blank, negative, and out-of-range values are refused before sending", () => {
    const draft = timersFromSettings(defaults);
    expect(
      "error" in settingsFromTimers({ ...draft, offerTtlSeconds: "" }),
    ).toBe(true);
    expect(
      "error" in settingsFromTimers({ ...draft, stopGraceSeconds: "-1" }),
    ).toBe(true);
    expect(
      "error" in settingsFromTimers({ ...draft, repositoryConfidence: "1.5" }),
    ).toBe(true);
  });
});

describe("the settings table", () => {
  test("routing is a project section every member can read", () => {
    const routing = SETTINGS_SECTIONS.find((s) => s.slug === "routing");
    expect(routing?.group).toBe("Project");
    expect(routing?.readAction).toBeNull();
  });
});
