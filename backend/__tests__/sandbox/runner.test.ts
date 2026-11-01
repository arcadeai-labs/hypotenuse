import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fillCommand,
  PROMPT_PLACEHOLDER,
  readConfig,
  Supervisor,
} from "../../sandbox/runner/runner";

/**
 * **The supervisor**, alone: it imports nothing from the backend, so it is
 * driven here with a fake CLI (a shell printing stream-json) and a fake
 * server (a `fetch` recording what was posted), and must turn one into the
 * other: events in order with their sequence numbers, a heartbeat, and a
 * completion that reads the exit.
 */

/** A recorded request. */
interface Posted {
  path: string;
  body: Record<string, unknown>;
}

/**
 * A fake server.
 * @param answers - What each path answers.
 * @returns The fetcher and what it saw.
 */
function fakeServer(
  answers: Record<
    string,
    unknown | ((body: Record<string, unknown>) => unknown)
  > = {},
) {
  const posted: Posted[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    posted.push({ path, body });
    const answer = answers[path];
    return Response.json(
      typeof answer === "function"
        ? answer(body)
        : (answer ?? { status: "succeeded" }),
    );
  }) as unknown as typeof fetch;
  return { fetcher, posted };
}

/**
 * A config pointing at a fake CLI.
 * @param script - The shell the CLI runs.
 * @returns The config.
 */
function configFor(script: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  writeFileSync(join(dir, "prompt.md"), "Do the work.");
  return readConfig({
    HYPOTENUSE_API_URL: "http://server.test/",
    HYPOTENUSE_JOB_TOKEN: "hyp_job_test",
    HYPOTENUSE_COMMAND: JSON.stringify([
      "sh",
      "-c",
      script,
      PROMPT_PLACEHOLDER,
    ]),
    HYPOTENUSE_CWD: dir,
    HYPOTENUSE_PROMPT_FILE: join(dir, "prompt.md"),
    HYPOTENUSE_LOG_FILE: join(dir, "supervisor.log"),
    HYPOTENUSE_HEARTBEAT_MS: "60000",
    ...extra,
  });
}

describe("configuration", () => {
  test("reads the environment, trims the API URL, and refuses one without a token", () => {
    const c = configFor("true");
    expect(c.apiUrl).toBe("http://server.test");
    expect(c.interactive).toBe(false);
    expect(() => readConfig({ HYPOTENUSE_API_URL: "x" })).toThrow(
      "HYPOTENUSE_JOB_TOKEN",
    );
  });

  test("fills placeholders anywhere in an argument", () => {
    expect(
      fillCommand(["claude", "-p", "__P__", "--x=__P__!"], { __P__: "hi" }),
    ).toEqual(["claude", "-p", "hi", "--x=hi!"]);
  });
});

describe("a run", () => {
  test("posts the CLI's events in order, a heartbeat, and a succeeded completion with its closing text and usage", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1", mcp_servers: [] },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Working." }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All done.",
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    ];
    const script = lines.map((l) => `echo '${JSON.stringify(l)}'`).join("; ");
    const { fetcher, posted } = fakeServer();
    const code = await new Supervisor(configFor(script), fetcher).run();
    expect(code).toBe(0);
    expect(posted[0].path).toBe("/sandbox/heartbeat");
    const events = posted
      .filter((p) => p.path === "/sandbox/events")
      .flatMap((p) => p.body.events as { type: string; seq: number }[]);
    expect(events.map((e) => e.type)).toEqual(["init", "assistant", "result"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const complete = posted.find((p) => p.path === "/sandbox/complete");
    expect(complete?.body).toMatchObject({
      token: "hyp_job_test",
      exitCode: 0,
      outcome: "succeeded",
      closingText: "All done.",
      cliSessionId: "s-1",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  test("a non-zero exit is failed, with the CLI's error", async () => {
    const result = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the build is broken",
    };
    const { fetcher, posted } = fakeServer();
    await new Supervisor(
      configFor(`echo '${JSON.stringify(result)}'; exit 2`),
      fetcher,
    ).run();
    expect(
      posted.find((p) => p.path === "/sandbox/complete")?.body,
    ).toMatchObject({
      exitCode: 2,
      outcome: "failed",
      error: "the build is broken",
    });
  });

  test("an MCP server that failed to start fails a clean exit", async () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "s",
      mcp_servers: [{ name: "hypotenuse", status: "failed" }],
    };
    const { fetcher, posted } = fakeServer();
    await new Supervisor(
      configFor(`echo '${JSON.stringify(init)}'`),
      fetcher,
    ).run();
    const complete = posted.find((p) => p.path === "/sandbox/complete");
    expect(complete?.body.outcome).toBe("failed");
    expect(String(complete?.body.error)).toContain("hypotenuse (failed)");
  });

  test("a cancel answered by the first heartbeat is reported cancelled without running the CLI", async () => {
    const { fetcher, posted } = fakeServer({
      "/sandbox/heartbeat": { cancelRequested: true },
    });
    await new Supervisor(configFor("sleep 30"), fetcher).run();
    expect(
      posted.find((p) => p.path === "/sandbox/complete")?.body,
    ).toMatchObject({ outcome: "cancelled", exitCode: 143 });
    expect(posted.some((p) => p.path === "/sandbox/events")).toBe(false);
  });

  test("an interactive job cancelled while it waits for a follow-up reports the cancel, so it ends at once", async () => {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "First turn done.",
    };
    let idle = 0;
    const { fetcher, posted } = fakeServer({
      "/sandbox/heartbeat": (body: Record<string, unknown>) => {
        if (body.phase === "idle") idle++;
        return { cancelRequested: idle >= 2 };
      },
      "/sandbox/complete": (body: Record<string, unknown>) => ({
        status: body.outcome === "succeeded" ? "awaiting_input" : "cancelled",
      }),
    });
    const code = await new Supervisor(
      configFor(`echo '${JSON.stringify(result)}'`, {
        HYPOTENUSE_INTERACTIVE: "true",
        HYPOTENUSE_HEARTBEAT_MS: "20",
      }),
      fetcher,
    ).run();
    expect(code).toBe(0);
    const completes = posted
      .filter((p) => p.path === "/sandbox/complete")
      .map((p) => p.body.outcome);
    expect(completes).toEqual(["succeeded", "cancelled"]);
  });
});
