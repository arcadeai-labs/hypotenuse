import { describe, expect, test } from "bun:test";
import { projectSettingsBody } from "../src/commands/project";
import {
  eventLine,
  jobStatusText,
  SANDBOX_JOB_STATUSES,
  usageText,
} from "../src/commands/sandbox";

describe("projectSettingsBody", () => {
  test("no flags is a view: an empty body", () => {
    expect(projectSettingsBody({})).toEqual({});
  });

  test("sends only the fields given, with durations in milliseconds", () => {
    expect(
      projectSettingsBody({
        sandboxProvider: "docker",
        sandboxImage: "ghcr.io/acme/agent:1",
        sandboxConcurrency: "2",
        sandboxMaxDuration: "30m",
      }),
    ).toEqual({
      sandboxProvider: "docker",
      sandboxImage: "ghcr.io/acme/agent:1",
      sandboxConcurrency: 2,
      sandboxMaxDurationMs: 1_800_000,
    });
  });

  test("each --no-* sends null, the deployment's default", () => {
    expect(
      projectSettingsBody({
        sandboxProvider: false,
        sandboxImage: false,
        sandboxConcurrency: false,
        sandboxMaxDuration: false,
      }),
    ).toEqual({
      sandboxProvider: null,
      sandboxImage: null,
      sandboxConcurrency: null,
      sandboxMaxDurationMs: null,
    });
  });

  test("a bad number or duration is refused, naming the flag", () => {
    expect(() => projectSettingsBody({ sandboxConcurrency: "two" })).toThrow(
      "--sandbox-concurrency",
    );
    expect(() => projectSettingsBody({ sandboxMaxDuration: "soon" })).toThrow(
      "--sandbox-max-duration",
    );
  });
});

describe("sandbox job rendering", () => {
  test("every status reads as words after a glyph", () => {
    for (const status of SANDBOX_JOB_STATUSES) {
      expect(jobStatusText(status)).toEndWith(` ${status.replace("_", " ")}`);
    }
  });

  test("usage counts tokens and requests, and names a budget", () => {
    expect(
      usageText({
        usage: { inputTokens: 1200, outputTokens: 300, requests: 1 },
        budgetTokens: null,
      }),
    ).toBe("1200 in / 300 out over 1 request");
    expect(
      usageText({
        usage: { inputTokens: 0, outputTokens: 0, requests: 4 },
        budgetTokens: 50_000,
      }),
    ).toBe("0 in / 0 out over 4 requests (budget 50000)");
  });

  test("an event is one line: its number, kind, tool, and text flattened", () => {
    const line = eventLine({
      id: 1,
      seq: 7,
      kind: "tool_use",
      toolName: "Bash",
      text: "ls\n  -la",
      occurredAt: Date.UTC(2026, 0, 1),
    });
    expect(line.startsWith("   7  ")).toBe(true);
    expect(line).toEndWith("tool_use Bash ls -la");
  });
});
