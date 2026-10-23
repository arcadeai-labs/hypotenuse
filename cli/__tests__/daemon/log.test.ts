import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOverrides } from "../../src/config/loader";
import type { Config } from "../../src/config/schema";
import type { DaemonApi } from "../../src/daemon/daemon-api";
import { describeEvent, EventSink } from "../../src/daemon/event-sink";
import {
  DaemonLog,
  PREVIEW_LIMIT,
  paintLogLine,
  preview,
} from "../../src/daemon/log";
import { StateDb } from "../../src/daemon/state";
import type { OutputMode } from "../../src/output/tty";

/**
 * The daemon log as a person reads it: colored on a terminal and plain in the
 * file, a `--log-level` that beats every other source, and at `debug` one line
 * per agent activity saying what it is.
 */

/**
 * An output mode with the given depth.
 * @param depth - The color depth.
 * @returns The mode.
 */
function mode(depth: OutputMode["depth"]): OutputMode {
  return {
    interactive: true,
    depth,
    json: false,
    unicode: true,
    lightBackground: false,
  };
}

const LINE =
  "2026-10-23T10:00:00.000Z error the turn failed: boom session=3 workItem=7";

describe("paintLogLine", () => {
  test("colors the level and the message and dims the time and field keys; the text is unchanged", () => {
    const painted = paintLogLine(LINE, mode("truecolor"));
    expect(painted).not.toBe(LINE);
    expect(painted).toContain("\x1b[2m2026-10-23T10:00:00.000Z\x1b[0m");
    expect(painted).toContain("\x1b[2msession=\x1b[0m");
    expect(painted).toContain("\x1b[38;2;");
    expect(painted.replace(/\x1b\[[0-9;]*m/g, "")).toBe(LINE);
  });

  test("each level gets its own color", () => {
    const levelColor = (level: string) =>
      /^\S+ (\x1b\[[0-9;]*m)/.exec(
        paintLogLine(
          `2026-10-23T10:00:00.000Z ${level} message`,
          mode("truecolor"),
        ).replace(/^\x1b\[2m(\S+)\x1b\[0m/, "$1"),
      )?.[1];
    const colors = ["error", "warn ", "info ", "debug"].map(levelColor);
    expect(new Set(colors).size).toBe(4);
  });

  test("leaves a line alone without color, or when it is not a log line", () => {
    expect(paintLogLine(LINE, mode("none"))).toBe(LINE);
    expect(paintLogLine("agent stderr: hello", mode("truecolor"))).toBe(
      "agent stderr: hello",
    );
  });

  test("the file is plain even when the echo is painted", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyp-log-"));
    try {
      const file = join(dir, "daemon.log");
      new DaemonLog(file, "info", false, true).error("boom", { session: 1 });
      const written = readFileSync(file, "utf8");
      expect(written).not.toContain("\x1b[");
      expect(written).toMatch(/ error boom session=1\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview", () => {
  const long = `first line\n\n  ${"x".repeat(500)}`;

  test("puts text on one line and cuts it below trace", () => {
    const cut = preview(long, "debug");
    expect(cut).not.toContain("\n");
    expect(cut.startsWith("first line x")).toBe(true);
    expect(cut).toHaveLength(PREVIEW_LIMIT);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("keeps all of it at trace", () => {
    expect(preview(long, "trace")).toBe(`first line ${"x".repeat(500)}`);
  });
});

describe("describeEvent", () => {
  test("says what each kind of activity is", () => {
    expect(describeEvent({ type: "thought", body: "Reading the repo" })).toBe(
      "Reading the repo",
    );
    expect(
      describeEvent({
        type: "action",
        action: "Read",
        parameter: "src/a.ts",
        result: "42 lines",
      }),
    ).toBe("Read src/a.ts → 42 lines");
    expect(
      describeEvent({
        type: "plan",
        entries: [
          { content: "Read", status: "completed" },
          { content: "Write the fix", status: "in_progress" },
          { content: "Open a PR", status: "pending" },
        ],
      }),
    ).toBe("1/3 done; now: Write the fix");
    expect(
      describeEvent({
        type: "elicitation",
        body: "Which one?",
        signal: "select",
        signalMetadata: { options: [{ value: "a" }] },
      }),
    ).toBe("[select] Which one?");
    expect(describeEvent({ type: "response", body: "Done" })).toBe("Done");
    expect(describeEvent({ type: "summary", title: "Fix it" })).toBe("Fix it");
    expect(
      describeEvent({
        type: "external_url",
        label: "PR",
        url: "https://example.com/1",
      }),
    ).toBe("PR https://example.com/1");
    expect(
      describeEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        contextUsed: 100,
        contextSize: 1000,
      }),
    ).toBe("in=10 out=5 context=100/1000");
    expect(describeEvent({ type: "status", state: "running" })).toBe("running");
  });
});

describe("the event sink at debug", () => {
  /**
   * Emit one thought through a sink logging at a level, into a file.
   * @param level - The log level.
   * @returns The log file's text.
   */
  function logged(level: "info" | "debug"): string {
    const dir = mkdtempSync(join(tmpdir(), "hyp-sink-log-"));
    try {
      const file = join(dir, "daemon.log");
      const state = new StateDb(":memory:");
      state.claimSession({
        agentSessionId: 1,
        linearSessionId: null,
        issueIdentifier: "ENG-1",
        role: "worker",
        repository: null,
        workItemId: 10,
        acpAgentId: "claude",
      });
      const sink = new EventSink(
        state,
        {} as DaemonApi,
        new DaemonLog(file, level, false),
        {
          onCancelRequested() {},
          onNotYours() {},
          onUnauthorized() {},
          onCompleted() {},
          onUnreachable() {},
        },
      );
      sink.close();
      sink.emit(
        { agentSessionId: 1, workItemId: 10 },
        { type: "thought", body: "Looking at\nthe tests" },
      );
      state.close();
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("logs each activity with what it says", () => {
    expect(logged("debug")).toMatch(
      / debug agent thought: Looking at the tests session=1 workItem=10 seq=1 ephemeral=false\n$/,
    );
  });

  test("logs nothing about it at info", () => {
    expect(logged("info")).toBe("");
  });
});

describe("--log-level", () => {
  // Only `server` and `log` are read.
  const config = {
    server: { url: "https://example.com" },
    log: { level: "info" },
  } as unknown as Config;

  test("beats -v, HYPOTENUSE_LOG_LEVEL, and the file", () => {
    expect(
      applyOverrides(
        config,
        { verbose: true, logLevel: "trace" },
        { HYPOTENUSE_LOG_LEVEL: "warn" },
      ).log.level,
    ).toBe("trace");
    expect(applyOverrides(config, { logLevel: "error" }, {}).log.level).toBe(
      "error",
    );
  });

  test("without it, -v then the environment then the file decide", () => {
    expect(
      applyOverrides(
        config,
        { verbose: true },
        { HYPOTENUSE_LOG_LEVEL: "warn" },
      ).log.level,
    ).toBe("debug");
    expect(
      applyOverrides(config, {}, { HYPOTENUSE_LOG_LEVEL: "warn" }).log.level,
    ).toBe("warn");
    expect(applyOverrides(config, {}, {}).log.level).toBe("info");
  });
});
