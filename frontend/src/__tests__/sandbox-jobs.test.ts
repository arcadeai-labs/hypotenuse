import { describe, expect, test } from "bun:test";
import { SANDBOX_POLICIES } from "../components/bots/SandboxSection";
import { SETTINGS_SECTIONS } from "../components/settings/sections";
import { DESTINATIONS } from "../components/shell/destinations";
import {
  answeredByWords,
  durationWords,
  eventLine,
  eventsQuery,
  formatTokens,
  isLiveJob,
  jobGlyphKind,
  jobStatusLabel,
  parseJobTokenBudget,
  parseSandboxSettings,
  SANDBOX_JOB_FILTERS,
  sandboxDraftOf,
  sandboxStartJobId,
  usageWords,
} from "../utils/sandboxJobs";

/** Every status the server reports, mirrored from the jobs table. */
const STATUSES = [
  "pending",
  "provisioning",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
];

describe("a sandbox job's status", () => {
  test("alive until it ends; only a live job can be cancelled", () => {
    expect(STATUSES.filter(isLiveJob)).toEqual([
      "pending",
      "provisioning",
      "running",
      "awaiting_input",
    ]);
  });

  test("every status has words of its own, none the raw name", () => {
    const labels = STATUSES.map(jobStatusLabel);
    expect(new Set(labels).size).toBe(STATUSES.length);
    for (const label of labels) expect(label).not.toMatch(/_/);
  });

  test("rings while alive, discs once over; a stop by a person or idleness is faded, not red", () => {
    expect(jobGlyphKind("pending")).toBe("provisioning");
    expect(jobGlyphKind("provisioning")).toBe("provisioning");
    expect(jobGlyphKind("running")).toBe("working");
    expect(jobGlyphKind("awaiting_input")).toBe("hibernating");
    expect(jobGlyphKind("succeeded")).toBe("complete");
    expect(jobGlyphKind("failed")).toBe("failed");
    expect(jobGlyphKind("timed_out")).toBe("failed");
    expect(jobGlyphKind("cancelled")).toBe("stale");
    expect(jobGlyphKind("expired")).toBe("stale");
  });

  test("the list's filters cover every status but the transient provisioning, after All", () => {
    expect(SANDBOX_JOB_FILTERS[0]).toEqual({ value: "", label: "All" });
    const values = SANDBOX_JOB_FILTERS.map((f) => f.value).filter(Boolean);
    expect(new Set(values)).toEqual(
      new Set(STATUSES.filter((s) => s !== "provisioning")),
    );
  });
});

describe("usage and time in words", () => {
  test("tokens are short", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(48_000)).toBe("48k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  test("usage counts input and output, against a budget when there is one", () => {
    expect(usageWords({ inputTokens: 1000, outputTokens: 500 }, null)).toBe(
      "1.5k tokens",
    );
    expect(usageWords({ inputTokens: 1000, outputTokens: 500 }, 50_000)).toBe(
      "1.5k of 50k tokens",
    );
  });

  test("durations read as a person says them", () => {
    expect(durationWords(45_000)).toBe("45 s");
    expect(durationWords(30 * 60_000)).toBe("30 min");
    expect(durationWords(2 * 3_600_000)).toBe("2 h");
    expect(durationWords(90 * 60_000)).toBe("1 h 30 min");
  });
});

describe("the project's sandbox settings", () => {
  const blank = { provider: "", image: "", concurrency: "", maxMinutes: "" };

  test("blank fields return to the deployment's defaults", () => {
    expect(parseSandboxSettings(blank)).toEqual({
      sandboxProvider: null,
      sandboxImage: null,
      sandboxConcurrency: null,
      sandboxMaxDurationMs: null,
    });
  });

  test("filled fields are what project:settings-edit takes", () => {
    expect(
      parseSandboxSettings({
        provider: "docker",
        image: " ghcr.io/acme/agent:1.2 ",
        concurrency: "3",
        maxMinutes: "45",
      }),
    ).toEqual({
      sandboxProvider: "docker",
      sandboxImage: "ghcr.io/acme/agent:1.2",
      sandboxConcurrency: 3,
      sandboxMaxDurationMs: 45 * 60_000,
    });
  });

  test("a bad field says what is wrong", () => {
    for (const concurrency of ["0", "51", "2.5", "many"]) {
      expect(parseSandboxSettings({ ...blank, concurrency })).toBeTypeOf(
        "string",
      );
    }
    for (const maxMinutes of ["0", "1.5", "-3"]) {
      expect(parseSandboxSettings({ ...blank, maxMinutes })).toBeTypeOf(
        "string",
      );
    }
    expect(parseSandboxSettings({ ...blank, image: "has a space" })).toBeTypeOf(
      "string",
    );
  });

  test("the saved settings round-trip through the fields", () => {
    const draft = sandboxDraftOf({
      sandboxProvider: "docker",
      sandboxConfig: { image: "node:22" },
      sandboxConcurrency: 4,
      sandboxMaxDurationMs: 20 * 60_000,
    });
    expect(draft).toEqual({
      provider: "docker",
      image: "node:22",
      concurrency: "4",
      maxMinutes: "20",
    });
    expect(
      sandboxDraftOf({
        sandboxProvider: null,
        sandboxConfig: {},
        sandboxConcurrency: null,
        sandboxMaxDurationMs: null,
      }),
    ).toEqual({ provider: "", image: "", concurrency: "", maxMinutes: "" });
  });

  test("is a project settings section", () => {
    expect(SETTINGS_SECTIONS.find((s) => s.slug === "sandboxes")?.group).toBe(
      "Project",
    );
  });
});

describe("a bot's sandbox settings", () => {
  test("the token budget is blank for no cap, else a whole number of at least 1,000", () => {
    expect(parseJobTokenBudget("")).toBeNull();
    expect(parseJobTokenBudget(" 50000 ")).toBe(50_000);
    expect(parseJobTokenBudget("50,000")).toBe(50_000);
    expect(parseJobTokenBudget("1000")).toBe(1000);
    for (const bad of ["999", "1.5k", "-2000", "lots"]) {
      expect(parseJobTokenBudget(bad)).toBeUndefined();
    }
  });

  test("the policy menu offers what bot:edit takes, the default first", () => {
    expect(SANDBOX_POLICIES.map((p) => p.value)).toEqual([
      "approve",
      "allow",
      "off",
    ]);
  });
});

describe("a sandbox job in a transcript", () => {
  test("a sandbox_start or sandbox_wait result names its job; anything else names none", () => {
    expect(sandboxStartJobId({ jobId: 7, status: "pending", note: "" })).toBe(
      7,
    );
    expect(
      sandboxStartJobId({ jobId: 8, note: "Waiting for sandbox job 8." }),
    ).toBe(8);
    for (const output of [null, undefined, {}, { jobId: "7" }, { jobId: 0 }]) {
      expect(sandboxStartJobId(output)).toBeNull();
    }
  });

  test("each event kind reads as a label and its text", () => {
    expect(
      eventLine({ kind: "assistant", toolName: null, text: "Done." }),
    ).toEqual({ label: "Agent", text: "Done." });
    expect(
      eventLine({ kind: "tool_use", toolName: "Bash", text: "bun test" }),
    ).toEqual({ label: "Bash", text: "bun test" });
    expect(
      eventLine({ kind: "tool_result", toolName: "Bash", text: null }),
    ).toEqual({ label: "Bash result", text: "" });
    expect(
      eventLine({ kind: "unknown", toolName: null, text: "x" }).label,
    ).toBe("unknown");
  });

  test("the transcript reads forward from a sequence number", () => {
    expect(eventsQuery(null)).toBe("?limit=100");
    expect(eventsQuery(42, 25)).toBe("?limit=25&afterSeq=42");
  });

  test("who answered a question", () => {
    expect(answeredByWords({ kind: "bot" })).toBe("the bot");
    expect(answeredByWords({ kind: "user", name: "Ada" })).toBe("Ada");
    expect(answeredByWords(null)).toBe("someone");
  });

  test("the sidebar's Sandboxes destination is live, on g s", () => {
    const sandboxes = DESTINATIONS.find((d) => d.id === "sandboxes");
    expect(sandboxes?.available).toBe(true);
    expect(sandboxes?.to).toBe("/sandboxes");
    expect(sandboxes?.shortcut).toBe("g s");
  });
});
