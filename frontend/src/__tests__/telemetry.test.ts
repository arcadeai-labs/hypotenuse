import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS } from "../components/settings/sections";
import {
  CONTENT_LEVEL_LABELS,
  CONTENT_LEVELS,
  draftFromExporter,
  emptyDraft,
  nativeSupport,
  noteParts,
  parseKeyValueLines,
  payloadFromDraft,
  showLastError,
  type TelemetryExporter,
} from "../utils/telemetry";

/**
 * An exporter as the list serializes it, with sensible defaults.
 * @param over - Fields to set.
 * @returns The exporter.
 */
function exporter(over: Partial<TelemetryExporter> = {}): TelemetryExporter {
  return {
    id: 1,
    projectId: 1,
    name: "honeycomb",
    enabled: true,
    endpoint: "https://api.honeycomb.io",
    protocol: "http/protobuf",
    headerNames: ["x-honeycomb-team"],
    signals: ["traces", "logs"],
    content: "content",
    agentNative: true,
    traceSampleRatio: 0.5,
    resourceAttributes: { "deployment.environment": "prod" },
    lastExportAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as TelemetryExporter;
}

describe("which presets contribute native telemetry", () => {
  test("each preset's answer, pinned", () => {
    const presets = [
      "claude",
      "codex",
      "gemini",
      "qwen",
      "goose",
      "opencode",
      "custom",
      "aider",
    ];
    expect(
      Object.fromEntries(presets.map((p) => [p, nativeSupport(p)])),
    ).toEqual({
      claude: "native",
      codex: "native",
      gemini: "native",
      qwen: "native",
      goose: "otel-env",
      opencode: "otel-env",
      custom: "none",
      aider: "none",
    });
  });

  test("the preset is matched case-insensitively", () => {
    expect(nativeSupport(" Claude ")).toBe("native");
  });
});

describe("an exporter's last error", () => {
  test("is shown only when it is newer than the last export", () => {
    const failing = { lastError: "503 from the collector" };
    expect(showLastError(exporter())).toBe(false);
    expect(showLastError(exporter({ ...failing, lastErrorAt: 5 }))).toBe(true);
    expect(
      showLastError(exporter({ ...failing, lastErrorAt: 5, lastExportAt: 4 })),
    ).toBe(true);
    expect(
      showLastError(exporter({ ...failing, lastErrorAt: 5, lastExportAt: 6 })),
    ).toBe(false);
    // The same instant is not "later": a success at that moment wins.
    expect(
      showLastError(exporter({ ...failing, lastErrorAt: 5, lastExportAt: 5 })),
    ).toBe(false);
  });
});

describe("the transcript's telemetry note", () => {
  test("backticked names become code", () => {
    expect(
      noteParts("telemetry capped at `content` by runner `laptop`"),
    ).toEqual([
      { code: false, text: "telemetry capped at " },
      { code: true, text: "content" },
      { code: false, text: " by runner " },
      { code: true, text: "laptop" },
    ]);
  });

  test("an unpaired backtick stays text", () => {
    expect(noteParts("runner `laptop sends none")).toEqual([
      { code: false, text: "runner `laptop sends none" },
    ]);
  });
});

describe("the exporter form", () => {
  test("every content level is explained", () => {
    for (const level of CONTENT_LEVELS)
      expect(CONTENT_LEVEL_LABELS[level].length).toBeGreaterThan(0);
    expect(CONTENT_LEVEL_LABELS.full).toContain("third party");
  });

  test("an edit keeps the headers unless told otherwise, and never pre-fills a value", () => {
    const draft = draftFromExporter(exporter());
    expect(draft.headers).toEqual([]);
    expect(draft.headerMode).toBe("keep");
    const out = payloadFromDraft(draft, true);
    expect("body" in out && "headers" in out.body).toBe(false);
  });

  test("clearing sends an empty object; replacing sends the rows whole", () => {
    const draft = draftFromExporter(exporter());
    const cleared = payloadFromDraft({ ...draft, headerMode: "clear" }, true);
    expect("body" in cleared && cleared.body.headers).toEqual({});
    const replaced = payloadFromDraft(
      {
        ...draft,
        headerMode: "replace",
        headers: [
          { name: "authorization", value: "Bearer x" },
          { name: "", value: "" },
        ],
      },
      true,
    );
    expect("body" in replaced && replaced.body.headers).toEqual({
      authorization: "Bearer x",
    });
  });

  test("replacing with no rows is refused rather than clearing by accident", () => {
    const draft = draftFromExporter(exporter());
    expect(
      payloadFromDraft({ ...draft, headerMode: "replace" }, true),
    ).toHaveProperty("error");
  });

  test("a create sends headers only when there are some", () => {
    const base = { ...emptyDraft(), name: "x", endpoint: "https://o.example" };
    const bare = payloadFromDraft(base, false);
    expect("body" in bare && "headers" in bare.body).toBe(false);
    const withOne = payloadFromDraft(
      { ...base, headers: [{ name: "k", value: "v" }] },
      false,
    );
    expect("body" in withOne && withOne.body.headers).toEqual({ k: "v" });
  });

  test("the round trip from an exporter is the exporter", () => {
    const out = payloadFromDraft(draftFromExporter(exporter()), true);
    expect(out).toEqual({
      body: {
        name: "honeycomb",
        endpoint: "https://api.honeycomb.io",
        protocol: "http/protobuf",
        content: "content",
        signals: ["traces", "logs"],
        traceSampleRatio: 0.5,
        agentNative: true,
        enabled: true,
        resourceAttributes: { "deployment.environment": "prod" },
      },
    });
  });

  test("bad input is refused with a sentence", () => {
    const base = { ...emptyDraft(), name: "x", endpoint: "https://o.example" };
    for (const bad of [
      { name: " " },
      { endpoint: "" },
      { signals: [] },
      { traceSampleRatio: "1.5" },
      { traceSampleRatio: "" },
      { traceSampleRatio: "half" },
      { resourceAttributes: "no-equals-sign" },
      { headers: [{ name: "", value: "orphan" }] },
    ])
      expect(payloadFromDraft({ ...base, ...bad }, false)).toHaveProperty(
        "error",
      );
  });

  test("resource attributes split on the first equals sign", () => {
    expect(parseKeyValueLines("a=b=c\n\n service.ns = web ")).toEqual({
      record: { a: "b=c", "service.ns": "web" },
    });
  });
});

describe("the telemetry settings section", () => {
  test("is a Project section every member reads", () => {
    const section = SETTINGS_SECTIONS.find((s) => s.slug === "telemetry");
    expect(section).toEqual({
      slug: "telemetry",
      label: "Telemetry",
      group: "Project",
      readAction: null,
    });
  });
});
