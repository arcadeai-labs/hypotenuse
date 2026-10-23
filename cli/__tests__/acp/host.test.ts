import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNED_IN_BODY } from "../../src/acp/host";
import { sessionLogPath } from "../../src/acp/lifecycle";
import {
  assignment,
  fakeConfig,
  SIGNATURE,
  TestTurn,
  unsigned,
} from "./harness";

/**
 * The real agent host against the fake ACP agent, one test per scenario:
 * what Hypotenuse sends the agent, and the exact events a turn emits.
 */

/**
 * A fresh home.
 * @returns A temporary directory.
 */
function home(): string {
  return mkdtempSync(join(tmpdir(), "hyp-host-"));
}

/**
 * Whether a process is alive.
 * @param pid - The process.
 * @returns True while it runs.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("acp host", () => {
  test("happy: the mapping, in order, and a completed turn", async () => {
    const turn = new TestTurn(fakeConfig(home()), "happy");
    const result = await turn.result;
    expect(result.outcome).toBe("completed");
    expect(result.acpSessionId).toMatch(/^fake-session-/);
    expect(turn.visible()).toEqual([
      {
        type: "thought",
        body: "Starting fake in its working directory…",
        ephemeral: true,
      },
      {
        type: "thought",
        body: "Reading the issue. The rounding happens in src/a.ts.",
        ephemeral: true,
      },
      {
        type: "plan",
        entries: [
          { content: "Find the rounding", status: "in_progress" },
          { content: "Fix it", status: "pending" },
          { content: "Run the tests", status: "pending" },
        ],
      },
      {
        type: "action",
        action: "Editing",
        parameter: "src/a.ts",
        ephemeral: true,
      },
      {
        type: "action",
        action: "Edited",
        parameter: "src/a.ts",
        result:
          "+1 −1 in src/a.ts\n\n+++ Diff\n```diff\n-round(x)\n+roundHalfEven(x)\n```\n+++",
        ephemeral: false,
      },
      {
        type: "plan",
        entries: [
          { content: "Find the rounding", status: "completed" },
          { content: "Fix it", status: "completed" },
          { content: "Run the tests", status: "completed" },
        ],
      },
      { type: "summary", title: "Fix checkout rounding" },
      { type: "response", body: "Fixed the rounding in `src/a.ts`." },
    ]);
    const received = turn.received();
    expect(received.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(received[0]?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        auth: { terminal: true },
        elicitation: { form: {}, url: {} },
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: "hypotenuse", title: "Hypotenuse" },
    });
    const prompt = received[2]?.params.prompt as {
      type: string;
      text?: string;
      uri?: string;
    }[];
    expect(prompt[0]?.text).toContain("<request>\nBegin.\n</request>");
    expect(prompt[1]).toMatchObject({
      type: "resource_link",
      uri: "https://linear.app/acme/issue/ENG-1/fix-checkout-rounding",
    });
    expect(turn.availability).toEqual([{ available: true }]);
    expect(turn.pids.at(-1)).toBeNull();
  }, 20_000);

  test("permission allow: answered by policy, never allow_always", async () => {
    const turn = new TestTurn(fakeConfig(home()), "permission");
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: "Removed build/.",
    });
    expect(turn.visible()).toContainEqual({
      type: "action",
      action: "Ran",
      parameter: "rm -rf build/",
      result: "```\nremoved build/\n```",
      ephemeral: false,
    });
  }, 20_000);

  test("permission deny: rejected once, the tool call fails", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), "", 'permission_policy = "deny"'),
      "permission",
    );
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible()).toContainEqual({
      type: "action",
      action: "Ran",
      parameter: "rm -rf build/",
      result: "Failed: permission denied by the user",
      ephemeral: false,
    });
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: "I did not remove build/.",
    });
  }, 20_000);

  test("permission ask: a select elicitation, the turn waits, a reply resumes it", async () => {
    const turn = new TestTurn(
      fakeConfig(
        home(),
        "",
        'permission_policy = { default = "allow", execute = "ask" }',
      ),
      "permission",
    );
    const asked = await turn.waitFor((e) => e.type === "elicitation");
    expect(asked).toEqual({
      type: "elicitation",
      body: "The agent wants to run `rm -rf build/` in its working directory. Allow it?",
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Allow", value: "yes" },
          { label: "Always allow", value: "always" },
          { label: "Reject", value: "no" },
        ],
      },
    });
    expect(turn.events).toContainEqual({
      type: "status",
      state: "waiting_permission",
    });
    expect(turn.replyHandler?.({ activityId: 7, body: "allow" })).toBe(true);
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: "Removed build/.",
    });
  }, 20_000);

  test("permission ask: free text rejects once and is not consumed", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), "", 'permission_policy = "ask"'),
      "permission",
    );
    await turn.waitFor((e) => e.type === "elicitation");
    expect(
      turn.replyHandler?.({ activityId: 8, body: "run the tests instead" }),
    ).toBe(false);
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: "I did not remove build/.",
    });
    // Nothing is waiting any more: a later reply is not this turn's.
    expect(turn.replyHandler?.({ activityId: 9, body: "yes" })).toBeNull();
  }, 20_000);

  test("permission ask: idle_timeout while waiting ends the turn with an error", async () => {
    const turn = new TestTurn(
      fakeConfig(
        home(),
        '[sessions]\nidle_timeout = "1s"\nkeepalive_interval = "1s"\nturn_timeout = "1m"',
        'permission_policy = "ask"',
      ),
      "permission",
    );
    const result = await turn.result;
    expect(result.outcome).toBe("failed");
    expect(turn.visible().at(-1)).toEqual({
      type: "error",
      body: "Waited 1s for an answer; reply to resume.",
    });
  }, 20_000);

  test("elicit-form: an enum form is a select, and the answer is the enum value", async () => {
    const turn = new TestTurn(fakeConfig(home()), "elicit-form");
    const asked = await turn.waitFor((e) => e.type === "elicitation");
    expect(asked).toEqual({
      type: "elicitation",
      body: "Which database should I use?",
      signal: "select",
      signalMetadata: {
        options: [
          { label: "postgres", value: "postgres" },
          { label: "sqlite", value: "sqlite" },
        ],
      },
    });
    expect(turn.replyHandler?.({ activityId: 3, body: "2" })).toBe(true);
    await turn.result;
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: 'Elicitation: {"action":"accept","content":{"db":"sqlite"}}',
    });
  }, 20_000);

  test("elicit-url: an auth elicitation with the link; the next reply accepts", async () => {
    const turn = new TestTurn(fakeConfig(home()), "elicit-url");
    const asked = await turn.waitFor((e) => e.type === "elicitation");
    expect(asked).toEqual({
      type: "elicitation",
      body: "Sign in to continue",
      signal: "auth",
      signalMetadata: {
        url: "https://example.com/login",
        provider: "fake",
        providerName: "Fake Agent",
      },
    });
    expect(turn.replyHandler?.({ activityId: 4, body: "done" })).toBe(true);
    await turn.result;
    expect(turn.visible().at(-1)).toEqual({
      type: "response",
      body: 'Elicitation: {"action":"accept"}',
    });
  }, 20_000);

  test("long + stop: session/cancel, the stop response, and the agent is gone", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), '[sessions]\nstop_grace = "2s"'),
      "long",
    );
    await Bun.sleep(1_000);
    const pid = turn.pids.find((p) => p !== null) as number;
    expect(alive(pid)).toBe(true);
    turn.stop("stop");
    const result = await turn.result;
    expect(result.outcome).toBe("cancelled");
    const body = (turn.visible().at(-1) as { body: string }).body;
    expect(turn.visible().at(-1)?.type).toBe("response");
    expect(body).toStartWith(
      "Stopped at your request. Changes so far are in `",
    );
    expect(turn.received().map((r) => r.method)).toContain("session/cancel");
    expect(alive(pid)).toBe(false);
  }, 20_000);

  test("slow-cancel: SIGTERM, then SIGKILL, within stop_grace + the kill grace", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), '[sessions]\nstop_grace = "1s"'),
      "slow-cancel",
    );
    await Bun.sleep(1_000);
    const pid = turn.pids.find((p) => p !== null) as number;
    const started = Date.now();
    turn.stop("kill");
    const result = await turn.result;
    expect(Date.now() - started).toBeLessThan(1_000 + 500 + 3_000);
    expect(result.outcome).toBe("cancelled");
    expect(alive(pid)).toBe(false);
    expect((turn.visible().at(-1) as { body: string }).body).toStartWith(
      "Cancelled from runner test-runner (`hypotenuse agents kill`).",
    );
  }, 20_000);

  test("disengaged: a stop the server asked for quietly says nothing", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), '[sessions]\nstop_grace = "2s"'),
      "long",
    );
    await Bun.sleep(800);
    turn.stop("delegate_removed");
    expect((await turn.result).outcome).toBe("cancelled");
    expect(turn.visible().map((e) => e.type)).toEqual(["thought"]);
  }, 20_000);

  test("a role's docs reach the agent; an unreadable one fails the turn", async () => {
    const root = home();
    await Bun.write(join(root, "process.md"), "Plans start with the demo.");
    const turn = new TestTurn(
      fakeConfig(
        root,
        "",
        'docs = ["process.md", "https://wiki.example.com/process"]',
      ),
      "happy",
    );
    expect((await turn.result).outcome).toBe("completed");
    const prompt = turn.received()[2]?.params.prompt as { text?: string }[];
    expect(prompt[0]?.text).toContain(
      `<doc source="${join(root, "process.md")}">\nPlans start with the demo.\n</doc>`,
    );
    expect(prompt[0]?.text).toContain("- https://wiki.example.com/process");

    const missing = new TestTurn(
      fakeConfig(home(), "", 'docs = ["missing.md"]'),
      "happy",
    );
    expect((await missing.result).outcome).toBe("failed");
    const last = missing.visible().at(-1) as { type: string; body: string };
    expect(last.type).toBe("error");
    expect(last.body).toStartWith(
      "Runner test-runner cannot read a worker doc:",
    );
  }, 20_000);

  test("crash: an error with the stderr tail, redacted", async () => {
    const turn = new TestTurn(fakeConfig(home()), "crash");
    const result = await turn.result;
    expect(result.outcome).toBe("failed");
    const last = turn.visible().at(-1) as { type: string; body: string };
    expect(last.type).toBe("error");
    expect(last.body).toStartWith("fake exited unexpectedly (code 1).");
    expect(last.body).toContain("panic: out of cheese");
    expect(last.body).toContain("key [redacted]");
    expect(last.body).not.toContain("sk-abcdef");
  }, 20_000);

  test("a command that does not exist: an error naming it, and the agent unavailable", async () => {
    const root = home();
    const config = fakeConfig(root);
    config.agents.fake = {
      ...config.agents.fake!,
      command: ["/nonexistent/agent-binary"],
    };
    const turn = new TestTurn(config, "happy");
    expect((await turn.result).outcome).toBe("failed");
    const last = turn.visible().at(-1) as { type: string; body: string };
    expect(last.type).toBe("error");
    expect(last.body).toContain("/nonexistent/agent-binary");
    expect(turn.availability[0]?.available).toBe(false);
  }, 20_000);

  test("refusal and max-tokens end with their errors", async () => {
    const refusal = new TestTurn(fakeConfig(home()), "refusal");
    expect((await refusal.result).outcome).toBe("failed");
    expect(refusal.visible().at(-1)).toEqual({
      type: "error",
      body: "The agent declined to continue: That would delete production data.",
    });
    const tokens = new TestTurn(fakeConfig(home()), "max-tokens");
    await tokens.result;
    expect(tokens.visible().at(-1)).toEqual({
      type: "error",
      body: "The agent ran out of output tokens. Progress so far is in the working directory; reply to continue.",
    });
  }, 20_000);

  test("auth-required with an agent-run method: authenticate once, then proceed", async () => {
    const turn = new TestTurn(fakeConfig(home()), "auth-required");
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.received().map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
  }, 20_000);

  test("LC-SIG-02 auth-required with only a terminal method: an auth elicitation naming the agent, and unavailable", async () => {
    const turn = new TestTurn(fakeConfig(home()), "auth-terminal");
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible().at(-1)).toEqual({
      type: "elicitation",
      body: "Fake Agent on runner test-runner is not logged in. Its owner can sign in on that machine with `hypotenuse agents login fake` — the link has the steps. Reply here once it's done and I'll carry on.",
      signal: "auth",
      signalMetadata: { provider: "fake", providerName: "Fake Agent" },
    });
    expect(turn.availability).toEqual([
      { available: false, error: "not logged in" },
    ]);
  }, 20_000);

  test("LC-AIG-01 the final response discloses the agent: role, agent, version, and runner, collapsed", async () => {
    const turn = new TestTurn(fakeConfig(home()), "happy");
    await turn.result;
    const response = turn.events.filter((e) => e.type === "response").at(-1);
    const body = response && "body" in response ? response.body : "";
    expect(body).toMatch(SIGNATURE);
    expect(body).toContain("+++ — Hypotenuse (worker, Fake Agent)\n");
    expect(body).toContain("on runner `test-runner`");
    expect(unsigned(body).length).toBeGreaterThan(0);
  }, 20_000);

  test("LC-SIG-02 a turn after an auth elicitation resumes with a thought", async () => {
    const followUp = assignment({
      kind: "prompt",
      prompt: [{ activityId: 9, body: "done" }],
      history: [
        {
          seq: 1,
          activityId: 1,
          direction: "outbound",
          type: "elicitation",
          body: "Sign in",
          signal: "auth",
        },
        {
          seq: 2,
          activityId: 9,
          direction: "inbound",
          type: "prompt",
          body: "done",
          signal: null,
        },
      ],
    });
    const turn = new TestTurn(fakeConfig(home()), "happy", {
      assignment: followUp,
    });
    expect((await turn.result).outcome).toBe("completed");
    expect(turn.visible()).toContainEqual({
      type: "thought",
      body: SIGNED_IN_BODY,
      ephemeral: false,
    });
  }, 20_000);

  test("loadable: a follow-up loads the session, discards the replay, and sends only the request", async () => {
    const followUp = assignment({
      kind: "prompt",
      fresh: false,
      prompt: [{ activityId: 9, body: "Also the README" }],
    });
    const turn = new TestTurn(fakeConfig(home()), "loadable", {
      assignment: followUp,
      previousAcpSessionId: "old-session",
    });
    expect((await turn.result).outcome).toBe("completed");
    const received = turn.received();
    expect(received.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/prompt",
    ]);
    expect(turn.visible().map((e) => e.type)).toEqual(["thought", "response"]);
    const text =
      (received[2]?.params.prompt as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("<request>\nAlso the README\n</request>");
    expect(text).not.toContain("<linear-context>");
    expect((await turn.result).acpSessionId).toBe("old-session");
  }, 20_000);

  test("resumable: session/resume is preferred over load", async () => {
    const turn = new TestTurn(fakeConfig(home()), "resumable", {
      assignment: assignment({
        kind: "prompt",
        fresh: false,
        prompt: [{ activityId: 2, body: "more" }],
      }),
      previousAcpSessionId: "old-session",
    });
    await turn.result;
    expect(turn.received().map((r) => r.method)).toEqual([
      "initialize",
      "session/resume",
      "session/prompt",
    ]);
  }, 20_000);

  test("a fresh follow-up starts a new session with the whole history", async () => {
    const turn = new TestTurn(fakeConfig(home()), "loadable", {
      assignment: assignment({
        kind: "prompt",
        fresh: true,
        history: [
          {
            seq: 1,
            activityId: 1,
            direction: "outbound",
            type: "response",
            body: "Fixed it.",
            signal: null,
          },
          {
            seq: 2,
            activityId: 2,
            direction: "inbound",
            type: "prompt",
            body: "Also the README",
            signal: null,
          },
        ],
        prompt: [{ activityId: 2, body: "Also the README" }],
      }),
      previousAcpSessionId: "old-session",
    });
    await turn.result;
    const received = turn.received();
    expect(received.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    const text =
      (received[2]?.params.prompt as { text: string }[])[0]?.text ?? "";
    expect(text).toContain(
      '<conversation>\n<turn role="agent">\nFixed it.\n</turn>\n</conversation>',
    );
    expect(text).toContain("<request>\nAlso the README\n</request>");
  }, 20_000);

  test("stdout-noise: three non-ACP lines in a row fail the turn", async () => {
    const turn = new TestTurn(fakeConfig(home()), "stdout-noise");
    expect((await turn.result).outcome).toBe("failed");
    const last = turn.visible().at(-1) as { type: string; body: string };
    expect(last.type).toBe("error");
    expect(last.body).toStartWith(
      "fake wrote 3 lines to stdout that are not ACP",
    );
  }, 20_000);

  test("turn_timeout: the cancel path with a timeout error", async () => {
    const turn = new TestTurn(
      fakeConfig(
        home(),
        '[sessions]\nturn_timeout = "1s"\nidle_timeout = "1s"\nkeepalive_interval = "1s"\nstop_grace = "1s"',
      ),
      "long",
    );
    const result = await turn.result;
    expect(result.outcome).toBe("failed");
    expect(turn.visible().at(-1)?.type).toBe("error");
  }, 20_000);

  test("after linear_ask_user, a timeout or a drain posts nothing that would hide the question", async () => {
    for (const ending of ["timeout", "drain"] as const) {
      const turn = new TestTurn(
        fakeConfig(
          home(),
          '[sessions]\nturn_timeout = "1s"\nidle_timeout = "1m"\nkeepalive_interval = "1m"\nstop_grace = "1s"',
        ),
        "long",
      );
      while (!turn.pids.some((p) => p !== null)) await Bun.sleep(20);
      await turn.waitFor((e) => e.type === "thought");
      turn.askingHandler?.(true);
      const asked = turn.events.length;
      if (ending === "drain") turn.stop("drain");
      const result = await turn.result;
      expect(result.outcome).toBe(ending === "drain" ? "cancelled" : "failed");
      expect(
        turn.events.slice(asked).filter((e) => e.type !== "status"),
      ).toEqual([]);
    }
  }, 30_000);

  test("after linear_ask_user, the person's own Stop is still answered", async () => {
    const turn = new TestTurn(
      fakeConfig(home(), '[sessions]\nstop_grace = "1s"'),
      "long",
    );
    while (!turn.pids.some((p) => p !== null)) await Bun.sleep(20);
    await turn.waitFor((e) => e.type === "thought");
    turn.askingHandler?.(true);
    turn.stop("stop");
    const result = await turn.result;
    expect(result.outcome).toBe("cancelled");
    expect(turn.visible().at(-1)?.type).toBe("response");
  }, 30_000);

  test("LC-BP-02 a quiet running turn gets an ephemeral keepalive thought naming where it is", async () => {
    const turn = new TestTurn(
      fakeConfig(
        home(),
        '[sessions]\nturn_timeout = "1m"\nidle_timeout = "1m"\nkeepalive_interval = "1s"\nstop_grace = "1s"',
      ),
      "long",
    );
    const kept = await turn.waitFor(
      (e) => e.type === "thought" && e.body.startsWith("Still working"),
    );
    expect(kept).toEqual({
      type: "thought",
      body: "Still working.",
      ephemeral: true,
    });
    turn.stop("stop");
    expect((await turn.result).outcome).toBe("cancelled");
  }, 20_000);

  test("LC-SES-06 LC-BP-02 a turn waiting on a person's answer sends no keepalive", async () => {
    const turn = new TestTurn(
      fakeConfig(
        home(),
        '[sessions]\nturn_timeout = "1m"\nidle_timeout = "1m"\nkeepalive_interval = "1s"\nstop_grace = "1s"',
      ),
      "long",
    );
    while (!turn.pids.some((p) => p !== null)) await Bun.sleep(20);
    await turn.waitFor((e) => e.type === "thought");
    // As linear_ask_user does: the session is awaitingInput from here on.
    turn.askingHandler?.(true);
    const asked = turn.events.length;
    await Bun.sleep(2_500);
    expect(turn.events.slice(asked).filter((e) => e.type !== "status")).toEqual(
      [],
    );
    turn.stop("stop");
    await turn.result;
  }, 20_000);

  test("the session log has stderr and a JSON-RPC trace", async () => {
    const stateDir = home();
    const turn = new TestTurn(fakeConfig(stateDir), "crash", { stateDir });
    await turn.result;
    const path = sessionLogPath(stateDir, 42);
    expect(existsSync(path)).toBe(true);
    const log = readFileSync(path, "utf8");
    expect(log).toContain("stderr panic: out of cheese");
    expect(log).toMatch(/rpc -> initialize \d+B/);
    expect(log).toMatch(/rpc <- session\/update \d+B/);
  }, 20_000);

  test("the role's mode is selected after the session opens", async () => {
    const turn = new TestTurn(fakeConfig(home(), "", 'mode = "plan"'), "echo", {
      env: { FAKE_ACP_SCRIPT: "" },
    });
    await turn.result;
    // The fake agent offers no modes, so the host continues in the default.
    expect(turn.received().map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
  }, 20_000);
});
