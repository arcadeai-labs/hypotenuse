import { describe, expect, test } from "bun:test";
import {
  buildTranscript,
  type Entry,
  promptChangeSummary,
  readContextUpdate,
} from "../components/transcript/model";
import {
  argumentDraft,
  argumentInputs,
  argumentsProblem,
  assemblyOrder,
  budgetUsage,
  estimateTokens,
  lastReviewedLabel,
  loadingSummary,
  PROJECT_SECTION_DENIED,
  parseKeywords,
  parseWhole,
  pinLabel,
  projectSectionDenied,
  reviewIntervalLabel,
  reviewIntervalOptions,
  sectionLocks,
  skillNameProblem,
  skillUsage,
  versionSourceLabel,
} from "../utils/prompts";

/**
 * A section with the fields the helpers read.
 * @param id - Its id.
 * @param fields - The rest.
 * @returns The section.
 */
function section(
  id: number,
  fields: {
    key: string;
    scope: "bot" | "project";
    loading?: string;
    position?: number;
    archived?: boolean;
  },
) {
  return {
    id,
    loading: "always",
    position: 0,
    archived: false,
    ...fields,
  };
}

describe("assembly order", () => {
  test("Identity, then the project's always, the bot's always, then contextual — project before bot", () => {
    const project = [
      section(10, { key: "glossary", scope: "project", loading: "contextual" }),
      section(11, { key: "tone", scope: "project", position: 2 }),
      section(12, { key: "safety", scope: "project", position: 1 }),
    ];
    const bot = [
      section(1, { key: "things-i-have-learned", scope: "bot", position: 2 }),
      section(2, { key: "how-i-work", scope: "bot", position: 1 }),
      section(3, {
        key: "release-notes",
        scope: "bot",
        loading: "contextual",
      }),
      section(4, { key: "identity", scope: "bot", position: 9 }),
      section(5, { key: "gone", scope: "bot", archived: true }),
    ];
    expect(assemblyOrder(project, bot).map((s) => s.key)).toEqual([
      "identity",
      "safety",
      "tone",
      "how-i-work",
      "things-i-have-learned",
      "glossary",
      "release-notes",
    ]);
  });

  test("a project's sections alone keep their own order", () => {
    expect(
      assemblyOrder(
        [
          section(2, { key: "b", scope: "project", loading: "contextual" }),
          section(1, { key: "a", scope: "project", position: 5 }),
        ],
        [],
      ).map((s) => s.key),
    ).toEqual(["a", "b"]);
  });
});

describe("what a section may become", () => {
  test("Identity always loads, is never the bot's, and is never deleted", () => {
    expect(sectionLocks({ key: "identity", scope: "bot" })).toEqual({
      canBeContextual: false,
      canBeAgentEditable: false,
      canDelete: false,
    });
  });

  test("a project section is never any bot's to edit", () => {
    expect(sectionLocks({ key: "identity", scope: "project" })).toEqual({
      canBeContextual: true,
      canBeAgentEditable: false,
      canDelete: true,
    });
  });

  test("any other bot section may be anything", () => {
    expect(sectionLocks({ key: "how-i-work", scope: "bot" })).toEqual({
      canBeContextual: true,
      canBeAgentEditable: true,
      canDelete: true,
    });
  });

  test("only an admin changes a project section; unknown standing is not a refusal", () => {
    expect(projectSectionDenied(undefined, { isAdmin: false })).toBe(
      PROJECT_SECTION_DENIED,
    );
    expect(projectSectionDenied(undefined, { isAdmin: true })).toBeUndefined();
    expect(projectSectionDenied(undefined, null)).toBeUndefined();
    expect(projectSectionDenied("Sign in first", { isAdmin: true })).toBe(
      "Sign in first",
    );
  });
});

describe("loading and keywords", () => {
  test("keywords are split on commas and spaces, lowercased, once each", () => {
    expect(parseKeywords("Release, changelog  release,,NOTES ")).toEqual([
      "release",
      "changelog",
      "notes",
    ]);
    expect(parseKeywords("  ")).toEqual([]);
  });

  test("a section's loading reads as words", () => {
    expect(loadingSummary({ loading: "always", keywords: ["x"] })).toBe(
      "Always",
    );
    expect(
      loadingSummary({ loading: "contextual", keywords: ["release", "notes"] }),
    ).toBe("When one of these comes up: release, notes");
    expect(loadingSummary({ loading: "contextual", keywords: [] })).toBe(
      "When a word of its title comes up",
    );
  });

  test("every version source has words, and an unknown one is itself", () => {
    expect(versionSourceLabel("agent")).toBe("Written by the bot");
    expect(versionSourceLabel("person")).toBe("Written by a person");
    expect(versionSourceLabel("revert")).toBe("Reverted by a person");
    expect(versionSourceLabel("seed")).toBe("Created with the bot");
    expect(versionSourceLabel("import")).toBe("import");
  });
});

describe("the prompt's size", () => {
  test("tokens are estimated at four characters each, as the server does", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("usage caps at 100% for drawing and says when it is over", () => {
    expect(budgetUsage(2_000, 8_000)).toEqual({ percent: 25, over: false });
    expect(budgetUsage(9_000, 8_000)).toEqual({ percent: 100, over: true });
    expect(budgetUsage(10, 0)).toEqual({ percent: 100, over: true });
  });

  test("a whole number in range, separators allowed, and nothing else", () => {
    expect(parseWhole("8000", 1_000, 200_000)).toBe(8_000);
    expect(parseWhole("12,000", 1_000, 200_000)).toBe(12_000);
    expect(parseWhole("0", 0, 50)).toBe(0);
    for (const bad of ["", "999", "200001", "1.5", "-1", "lots"]) {
      expect(parseWhole(bad, 1_000, 200_000), bad).toBeNull();
    }
  });
});

describe("goals", () => {
  test("review intervals read as words", () => {
    expect(reviewIntervalLabel(null)).toBe("Never");
    expect(reviewIntervalLabel(86_400)).toBe("Every day");
    expect(reviewIntervalLabel(7 * 86_400)).toBe("Every 7 days");
    expect(reviewIntervalLabel(3_600)).toBe("Every hour");
    expect(reviewIntervalLabel(3 * 3_600)).toBe("Every 3 hours");
    expect(reviewIntervalLabel(5_400)).toBe("Every 90 minutes");
  });

  test("a goal's own interval is offered even when it is not a preset", () => {
    const presets = reviewIntervalOptions(null);
    expect(presets[0]).toBeNull();
    expect(reviewIntervalOptions(86_400)).toEqual(presets);
    const custom = reviewIntervalOptions(3 * 3_600);
    expect(custom).toContain(3 * 3_600);
    expect(custom.length).toBe(presets.length + 1);
    // In order, never first.
    expect(custom.indexOf(3 * 3_600)).toBe(1);
  });

  test("a goal never reviewed says whether it is on a schedule", () => {
    expect(
      lastReviewedLabel({ lastReviewedAt: null, reviewEverySeconds: null }),
    ).toBe("Not reviewed on a schedule");
    expect(
      lastReviewedLabel({ lastReviewedAt: null, reviewEverySeconds: 86_400 }),
    ).toBe("Not reviewed yet");
    expect(
      lastReviewedLabel({ lastReviewedAt: 0, reviewEverySeconds: 86_400 }),
    ).toStartWith("Last reviewed ");
  });
});

describe("skills", () => {
  test("arguments go to the API trimmed, blanks left out", () => {
    expect(
      argumentInputs([
        { name: " version ", description: " ", required: true, default: "" },
        {
          name: "audience",
          description: "Who reads it",
          required: false,
          default: "customers",
        },
      ]),
    ).toEqual([
      { name: "version", required: true },
      {
        name: "audience",
        description: "Who reads it",
        required: false,
        default: "customers",
      },
    ]);
    expect(argumentDraft({ name: "x" })).toEqual({
      name: "x",
      description: "",
      required: false,
      default: "",
    });
  });

  test("an argument problem is named before the server is asked", () => {
    const arg = (name: string) => argumentDraft({ name });
    expect(argumentsProblem([arg("version"), arg("audience")])).toBeNull();
    expect(argumentsProblem([arg("")])).toBe("Every argument needs a name.");
    expect(argumentsProblem([arg("2fast")])).toContain("is not a name");
    expect(argumentsProblem([arg("ARGUMENTS")])).toContain("reserved");
    expect(argumentsProblem([arg("a"), arg("a")])).toBe(
      'Two arguments are called "a".',
    );
  });

  test("a skill name is lowercase words joined by hyphens", () => {
    expect(skillNameProblem("release-notes")).toBeNull();
    expect(skillNameProblem("Release-Notes")).toBeNull();
    expect(skillNameProblem("")).toBe("A skill needs a name.");
    expect(skillNameProblem("release notes")).toContain("hyphens");
    expect(skillNameProblem("-x")).toContain("hyphens");
  });

  test("usage marks required and optional arguments", () => {
    expect(
      skillUsage({
        name: "release-notes",
        arguments: [
          { name: "version", required: true },
          { name: "audience", required: false },
        ],
      }),
    ).toBe("/release-notes <version> [audience]");
    expect(skillUsage({ name: "standup", arguments: [] })).toBe("/standup");
  });

  test("a pin reads as the version used", () => {
    expect(pinLabel({ pinnedVersion: null, currentVersion: 3 })).toBe(
      "Latest (v3)",
    );
    expect(pinLabel({ pinnedVersion: 2, currentVersion: 3 })).toBe(
      "Pinned to v2 of 3",
    );
  });
});

/**
 * A `context_update` entry.
 * @param seq - Its seq.
 * @param content - Its content.
 * @returns The entry.
 */
function update(seq: number, content: Record<string, unknown>): Entry {
  return {
    id: seq,
    conversationId: 1,
    seq,
    epoch: 1,
    stepId: null,
    kind: "context_update",
    role: null,
    content,
    toolCallId: null,
    toolName: null,
    replay: null,
    interrupted: false,
    promptHash: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    userId: null,
    participantId: null,
    createdAt: 1_000 + seq,
  } as Entry;
}

describe("the transcript's context updates", () => {
  const ref = (id: number, key: string, version: number) => ({
    id,
    key,
    version,
  });

  test("a prompt change names what changed, was added, removed, and dropped", () => {
    const change = readContextUpdate({
      prompt: "You are Ada.",
      previousPromptHash: "abc",
      sections: [ref(1, "identity", 1), ref(2, "how-i-work", 3)],
      added: [ref(5, "release-notes", 1)],
      removed: [ref(6, "old", 2)],
      changed: [{ ...ref(2, "how-i-work", 3), previousVersion: 2 }],
      dropped: [ref(7, "glossary", 1)],
      estimatedTokens: 900,
      budgetTokens: 8_000,
    });
    expect(change).toMatchObject({
      kind: "prompt",
      first: false,
      changed: [{ id: 2, key: "how-i-work", version: 3, previousVersion: 2 }],
      added: [{ key: "release-notes" }],
      removed: [{ key: "old" }],
      dropped: [{ key: "glossary" }],
      estimatedTokens: 900,
      budgetTokens: 8_000,
    });
    if (change.kind !== "prompt") throw new Error("not a prompt change");
    expect(promptChangeSummary(change)).toBe(
      "how-i-work v2 → v3; added release-notes; removed old; dropped glossary",
    );
  });

  test("the first prompt counts its sections; one that moved nothing says what else could have", () => {
    const first = readContextUpdate({
      prompt: "p",
      previousPromptHash: null,
      sections: [ref(1, "identity", 1), ref(2, "how-i-work", 1)],
      added: [ref(1, "identity", 1), ref(2, "how-i-work", 1)],
      removed: [],
      changed: [],
      dropped: [],
    });
    if (first.kind !== "prompt") throw new Error("not a prompt change");
    expect(first.first).toBe(true);
    expect(promptChangeSummary(first)).toBe("2 sections");

    const quiet = readContextUpdate({
      prompt: "p2",
      previousPromptHash: "abc",
      sections: [ref(1, "identity", 1)],
      added: [],
      removed: [],
      changed: [],
      dropped: [],
    });
    if (quiet.kind !== "prompt") throw new Error("not a prompt change");
    expect(promptChangeSummary(quiet)).toBe(
      "its goals, skills, tools, or channel changed",
    );
  });

  test("an entry that recorded only the text still reads, and junk refs are dropped", () => {
    const legacy = readContextUpdate({ prompt: "You are Ada." });
    expect(legacy).toMatchObject({
      kind: "prompt",
      prompt: "You are Ada.",
      first: true,
      sections: [],
      estimatedTokens: null,
    });
    if (legacy.kind !== "prompt") throw new Error("not a prompt change");
    expect(promptChangeSummary(legacy)).toBe("");
    const junk = readContextUpdate({
      previousPromptHash: "x",
      added: [{ key: "no-id" }, "nonsense", ref(3, "ok", 1)],
    });
    if (junk.kind !== "prompt") throw new Error("not a prompt change");
    expect(junk.added).toEqual([ref(3, "ok", 1)]);
  });

  test("a skill expansion carries its text, or why it could not be filled in", () => {
    expect(
      readContextUpdate({
        skill: {
          name: "release-notes",
          version: 2,
          arguments: "2.4 customers",
          text: "Draft notes for 2.4.",
        },
      }),
    ).toEqual({
      kind: "skill",
      name: "release-notes",
      version: 2,
      arguments: "2.4 customers",
      text: "Draft notes for 2.4.",
      error: null,
    });
    expect(
      readContextUpdate({
        skill: {
          name: "release-notes",
          version: 2,
          arguments: "",
          text: null,
          error: "The argument version is required.",
        },
      }),
    ).toMatchObject({
      kind: "skill",
      text: null,
      error: "The argument version is required.",
    });
  });

  test("buildTranscript draws each kind as its own line", () => {
    const items = buildTranscript(
      [
        update(1, {
          prompt: "p",
          previousPromptHash: null,
          sections: [ref(1, "identity", 1)],
        }),
        update(2, {
          skill: { name: "standup", version: 1, arguments: "", text: "Go." },
        }),
      ],
      false,
    );
    expect(items.map((i) => i.kind)).toEqual(["prompt", "skill"]);
    expect(items[1]).toMatchObject({ key: "e2", seq: 2, name: "standup" });
  });
});
