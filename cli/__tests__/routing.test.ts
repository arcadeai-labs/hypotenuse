import { describe, expect, test } from "bun:test";
import {
  describeMatch,
  describeRoutingSettings,
  describeRules,
  formatDuration,
  hasMatchFlags,
  listOption,
  managerSettingsBody,
  matchFromFlags,
  parseDuration,
  type RoutingRule,
  settingsBody,
  unknownCatalogNames,
} from "../src/commands/routing";

/**
 * A rule with defaults.
 * @param overrides - Fields to set.
 * @returns The rule.
 */
function rule(overrides: Partial<RoutingRule>): RoutingRule {
  return {
    id: 1,
    projectId: 1,
    position: 0,
    name: "/manage",
    enabled: true,
    match: { promptPrefix: "/manage" },
    role: "manager",
    repository: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("durations", () => {
  test("every unit parses to milliseconds", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("600000ms")).toBe(600_000);
    expect(parseDuration("2500")).toBe(2_500);
    expect(parseDuration("0")).toBe(0);
  });

  test("anything else is refused", () => {
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
    expect(() => parseDuration("-5m")).toThrow(/not a duration/);
  });

  test("formatting picks the largest whole unit", () => {
    expect(formatDuration(1_800_000)).toBe("30m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(1_500)).toBe("1500ms");
    expect(formatDuration(0)).toBe("0ms");
  });
});

describe("rule flags", () => {
  test("repeatable, comma-separated lists flatten", () => {
    expect(listOption(["PRD, docs", "infra"])).toEqual([
      "PRD",
      "docs",
      "infra",
    ]);
    expect(listOption(undefined)).toBeUndefined();
    expect(listOption([" , "])).toBeUndefined();
  });

  test("the match holds only the fields given", () => {
    expect(
      matchFromFlags({
        label: ["PRD"],
        team: ["ENG,OPS"],
        project: ["p1"],
        prefix: "/manage",
        hasParent: false,
        origin: "mention",
      }),
    ).toEqual({
      labels: ["PRD"],
      teamKeys: ["ENG", "OPS"],
      projectIds: ["p1"],
      promptPrefix: "/manage",
      hasParent: false,
      origin: "mention",
    });
    expect(matchFromFlags({ name: "x", role: "worker" })).toEqual({});
    expect(hasMatchFlags({ name: "x" })).toBe(false);
    expect(hasMatchFlags({ hasParent: true })).toBe(true);
  });

  test("the project-content match reads both ways", () => {
    expect(matchFromFlags({ projectHasContent: false })).toEqual({
      projectHasContent: false,
    });
    expect(hasMatchFlags({ projectHasContent: true })).toBe(true);
    expect(describeMatch({ hasParent: false, projectHasContent: false })).toBe(
      "not sub-issue project empty",
    );
  });

  test("an unknown origin is refused", () => {
    expect(() => matchFromFlags({ origin: "automation" })).toThrow(/origin/);
  });
});

describe("rendering", () => {
  test("a match reads as one line; an empty one matches anything", () => {
    expect(
      describeMatch({ labels: ["PRD"], teamKeys: ["ENG"], hasParent: true }),
    ).toBe("labels=PRD team=ENG sub-issue");
    expect(describeMatch({})).toBe("anything");
  });

  test("the rule list is numbered from 1 and says the fallthrough", () => {
    const text = describeRules([
      rule({}),
      rule({
        id: 2,
        position: 1,
        name: "/work",
        role: "worker",
        match: { promptPrefix: "/work" },
        enabled: false,
      }),
    ]);
    expect(text).toContain("/manage");
    expect(text).toContain("prefix=/work");
    expect(text).toContain("No match: worker.");
  });

  test("settings show durations and an off sticky timeout", () => {
    const text = describeRoutingSettings({
      queueTimeoutMs: 1_800_000,
      stickyTimeoutMs: 0,
      offerTtlMs: 10_000,
      repositoryConfidence: 0.7,
      stopGraceMs: 30_000,
      maxReviewRounds: 3,
    });
    expect(text).toContain("queue timeout          30m");
    expect(text).toContain("sticky timeout         off");
    expect(text).toContain("repository confidence  0.7");
  });
});

describe("settings edits", () => {
  test("flags become the routing body; --reset sends null", () => {
    expect(
      settingsBody({
        queueTimeout: "45m",
        offerTtl: "15s",
        repositoryConfidence: "0.8",
        reset: ["stopGraceMs"],
      }),
    ).toEqual({
      queueTimeoutMs: 2_700_000,
      offerTtlMs: 15_000,
      repositoryConfidence: 0.8,
      stopGraceMs: null,
    });
  });

  test("no flags is a read", () => {
    expect(settingsBody({})).toBeNull();
  });

  test("bad values and unknown keys are refused", () => {
    expect(() => settingsBody({ repositoryConfidence: "2" })).toThrow(/0 to 1/);
    expect(() => settingsBody({ reset: ["nope"] })).toThrow(/Unknown setting/);
  });

  test("manager flags become the manager body, apart from routing's; --reset sends either section its null", () => {
    const flags = {
      maxParallelDispatch: "5",
      managerCanComplete: "yes",
      reset: ["canCompleteIssues", "maxReviewRounds"],
    };
    expect(managerSettingsBody(flags)).toEqual({
      maxParallelDispatch: 5,
      canCompleteIssues: null,
    });
    expect(settingsBody(flags)).toEqual({ maxReviewRounds: null });
    expect(managerSettingsBody({ managerCanComplete: "no" })).toEqual({
      canCompleteIssues: false,
    });
    expect(managerSettingsBody({})).toBeNull();
    expect(() => managerSettingsBody({ maxParallelDispatch: "0" })).toThrow(
      /at least 1/,
    );
    expect(() => managerSettingsBody({ managerCanComplete: "maybe" })).toThrow(
      /yes or no/,
    );
  });

  test("settings show the manager section when the server sends it", () => {
    const text = describeRoutingSettings(
      {
        queueTimeoutMs: 1_800_000,
        stickyTimeoutMs: 600_000,
        offerTtlMs: 10_000,
        repositoryConfidence: 0.7,
        stopGraceMs: 30_000,
        maxReviewRounds: 3,
      },
      { canCompleteIssues: false, maxParallelDispatch: 3 },
    );
    expect(text).toContain("max parallel dispatch  3");
    expect(text).toContain("manager completes      no");
  });
});

describe("catalog checks", () => {
  const catalog = {
    teams: [{ key: "ENG" }],
    labels: [{ name: "PRD" }, { name: "Bug" }],
  };

  test("known names, in any case, pass", () => {
    expect(
      unknownCatalogNames(
        { labels: ["prd", "BUG"], teamKeys: ["eng"] },
        catalog,
      ),
    ).toEqual([]);
  });

  test("unknown labels and team keys are named", () => {
    expect(
      unknownCatalogNames({ labels: ["Nope"], teamKeys: ["OPS"] }, catalog),
    ).toEqual([
      "No label named Nope in the workspace.",
      "No team with key OPS in the workspace.",
    ]);
  });
});
