#!/usr/bin/env bun
/**
 * The scripted fake ACP agent: a real ACP agent built on the SDK's agent
 * side, with no model behind it. It speaks stdio like any coding agent and
 * plays a **scenario**: `FAKE_ACP_SCENARIO` names one in `scenarios/*.json`
 * beside this file, or `FAKE_ACP_SCRIPT` is a path to one. Every request and
 * notification it receives is appended to `FAKE_ACP_RECORD` (a JSONL path),
 * so a test can assert on exactly what Hypotenuse sent.
 *
 * A scenario is JSON:
 *
 * ```json
 * { "authMethods": [...], "agentCapabilities": {...},
 *   "authRequired": "until-authenticate" | "always",
 *   "ignoreCancel": false,
 *   "replay": [<SessionUpdate>, ...],          // sent on session/load
 *   "turns": [[<step>, ...], ...] }            // turn n plays turns[min(n, last)]
 *
 * Every turn is a new agent process, so "turn n" counts the prompts this
 * Hypotenuse session (`HYPOTENUSE_SESSION_ID`) already sent, from the record.
 * ```
 *
 * Steps: `{ "update": <SessionUpdate> }`, `{ "sleep": ms }` (or
 * `{ "sleepEnv": "VAR", "default": ms }`), `{ "permission": { toolCall,
 * options }, "allowed": [steps], "rejected": [steps] }`, `{ "elicit": <params
 * without sessionId> }` (the answer is echoed as a message), `{ "echoPrompt":
 * true }`, `{ "stderr": "text" }`, `{ "stdout": "text" }`, `{ "exit": code }`,
 * `{ "ticks": { "everyMs": 500, "env": "VAR", "default": ms } }` (an
 * in-progress tool call every `everyMs` for that long — a turn that keeps
 * producing ephemeral actions), `{ "shell": "command" }` (run in the
 * session's `cwd` with `sh -c`, reported as an `execute` tool call whose
 * output is the command's), and `{ "stop": "end_turn" }`.
 *
 * `FAKE_ACP_AUTH_METHODS` (comma-separated ids) overrides `authMethods`.
 * `authRequired: "until-login"` refuses sessions until the file at
 * `FAKE_ACP_LOGIN_MARKER` exists; running the agent with `--login` (a
 * terminal auth method's args) creates it and exits.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type Step = Record<string, unknown>;

if (process.argv.includes("--login")) {
  const marker = process.env.FAKE_ACP_LOGIN_MARKER;
  if (marker) writeFileSync(marker, "logged in");
  console.log("Logged in to the fake agent.");
  process.exit(0);
}

interface Scenario {
  authMethods?: acp.AuthMethod[];
  agentCapabilities?: acp.AgentCapabilities;
  authRequired?: "until-authenticate" | "until-login" | "always";
  ignoreCancel?: boolean;
  replay?: acp.SessionUpdate[];
  turns?: Step[][];
}

const scenario: Scenario = (() => {
  const script = process.env.FAKE_ACP_SCRIPT;
  if (script) return JSON.parse(readFileSync(script, "utf8"));
  const name = process.env.FAKE_ACP_SCENARIO;
  if (name)
    return JSON.parse(
      readFileSync(join(import.meta.dir, "scenarios", `${name}.json`), "utf8"),
    );
  return {};
})();

const authMethods: acp.AuthMethod[] = process.env.FAKE_ACP_AUTH_METHODS
  ? process.env.FAKE_ACP_AUTH_METHODS.split(",")
      .filter(Boolean)
      .map((id) => ({ id, name: id }))
  : (scenario.authMethods ?? []);

/**
 * Append one received message to the record file.
 * @param method - The method.
 * @param params - Its params.
 */
function record(method: string, params: unknown): void {
  const file = process.env.FAKE_ACP_RECORD;
  if (file)
    appendFileSync(
      file,
      `${JSON.stringify({ method, params, pid: process.pid, session: process.env.HYPOTENUSE_SESSION_ID ?? null })}\n`,
    );
}

/**
 * How many prompts this Hypotenuse session sent before, by the record file.
 * @returns The count (the in-process count without a record).
 */
function previousTurns(): number {
  const file = process.env.FAKE_ACP_RECORD;
  const session = process.env.HYPOTENUSE_SESSION_ID;
  if (!file || !session || !existsSync(file)) return turn;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; session: string | null })
    .filter((r) => r.method === "session/prompt" && r.session === session)
    .length;
}

let authenticated = false;
/** Each session's working directory, substituted for `$CWD` in updates. */
const cwds = new Map<string, string>();
let turn = 0;
let sessionCounter = 0;
const cancelled = new Map<string, AbortController>();

/**
 * Wait, or stop waiting when the turn is cancelled.
 * @param ms - How long.
 * @param signal - The turn's cancel signal.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The text of a prompt's text blocks.
 * @param prompt - The blocks.
 * @returns Their text, joined.
 */
function promptText(prompt: acp.ContentBlock[]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

/**
 * Play steps until one stops the turn.
 * @param client - The client.
 * @param sessionId - The session.
 * @param steps - The steps.
 * @param signal - Fires on `session/cancel`.
 * @param prompt - The turn's prompt.
 * @returns The stop reason, or null to continue.
 */
async function play(
  client: acp.AgentContext,
  sessionId: string,
  steps: Step[],
  signal: AbortSignal,
  prompt: acp.ContentBlock[],
): Promise<acp.StopReason | null> {
  for (const step of steps) {
    if (signal.aborted && !scenario.ignoreCancel) return "cancelled";
    if (step.update) {
      const cwd = cwds.get(sessionId) ?? process.cwd();
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: JSON.parse(
          JSON.stringify(step.update).replaceAll("$CWD", cwd),
        ) as acp.SessionUpdate,
      });
    } else if (step.sleep !== undefined || step.sleepEnv) {
      const ms = step.sleepEnv
        ? Number(process.env[step.sleepEnv as string] ?? step.default ?? 0)
        : Number(step.sleep);
      await sleep(
        ms,
        scenario.ignoreCancel ? new AbortController().signal : signal,
      );
    } else if (step.ticks) {
      const ticks = step.ticks as {
        everyMs: number;
        env?: string;
        default?: number;
      };
      const total = Number(
        (ticks.env ? process.env[ticks.env] : undefined) ?? ticks.default ?? 0,
      );
      const until = Date.now() + total;
      for (let n = 1; Date.now() < until; n++) {
        if (signal.aborted && !scenario.ignoreCancel) return "cancelled";
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `tick-${n}`,
            title: `Step ${n}`,
            kind: "think",
            status: "in_progress",
            rawInput: { step: n },
          },
        });
        await sleep(
          Math.min(ticks.everyMs, Math.max(0, until - Date.now())),
          signal,
        );
      }
    } else if (step.permission) {
      const answer = await client.request(
        acp.methods.client.session.requestPermission,
        { sessionId, ...(step.permission as object) } as never,
      );
      const outcome = answer.outcome;
      if (outcome.outcome === "cancelled") return "cancelled";
      const options = (step.permission as { options: acp.PermissionOption[] })
        .options;
      const chosen = options.find((o) => o.optionId === outcome.optionId);
      const branch = chosen?.kind.startsWith("allow")
        ? (step.allowed as Step[] | undefined)
        : (step.rejected as Step[] | undefined);
      const stop = await play(client, sessionId, branch ?? [], signal, prompt);
      if (stop) return stop;
    } else if (step.elicit) {
      const answer = await client.request(
        acp.methods.client.elicitation.create,
        {
          sessionId,
          ...(step.elicit as object),
        } as never,
      );
      if (answer.action === "cancel") return "cancelled";
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Elicitation: ${JSON.stringify(answer)}`,
          },
        },
      });
    } else if (typeof step.shell === "string") {
      const cwd = cwds.get(sessionId) ?? process.cwd();
      const toolCallId = `shell-${crypto.randomUUID()}`;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: step.shell,
          kind: "execute",
          status: "in_progress",
          rawInput: { command: step.shell },
        },
      });
      const run = Bun.spawnSync(["sh", "-c", step.shell], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: run.exitCode === 0 ? "completed" : "failed",
          rawOutput: {
            output: `${run.stdout.toString()}${run.stderr.toString()}`,
          },
        },
      });
    } else if (step.echoPrompt) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `You said: ${promptText(prompt)}` },
        },
      });
    } else if (typeof step.stderr === "string") {
      process.stderr.write(`${step.stderr}\n`);
    } else if (typeof step.stdout === "string") {
      process.stdout.write(`${step.stdout}\n`);
    } else if (step.exit !== undefined) {
      await Bun.sleep(20);
      process.exit(Number(step.exit));
    } else if (step.stop) {
      return step.stop as acp.StopReason;
    }
  }
  return null;
}

/**
 * Refuse a session when the scenario wants authentication first.
 * @throws ACP's auth_required.
 */
function checkAuth(): void {
  const marker = process.env.FAKE_ACP_LOGIN_MARKER;
  if (
    scenario.authRequired === "always" ||
    (scenario.authRequired === "until-authenticate" && !authenticated) ||
    (scenario.authRequired === "until-login" && !(marker && existsSync(marker)))
  ) {
    throw acp.RequestError.authRequired();
  }
}

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    record("initialize", params);
    return {
      protocolVersion: 1,
      agentInfo: { name: "fake-agent", title: "Fake Agent", version: "1.2.3" },
      agentCapabilities: scenario.agentCapabilities ?? { loadSession: true },
      authMethods,
    };
  })
  .onRequest(acp.methods.agent.authenticate, ({ params }) => {
    record("authenticate", params);
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    record("session/new", params);
    checkAuth();
    sessionCounter++;
    const sessionId = `fake-session-${process.pid}-${sessionCounter}`;
    cwds.set(sessionId, params.cwd);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    record("session/load", params);
    checkAuth();
    cwds.set(params.sessionId, params.cwd);
    for (const update of scenario.replay ?? []) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update,
      });
    }
    return {};
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    record("session/resume", params);
    checkAuth();
    cwds.set(params.sessionId, params.cwd);
    return {};
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    record("session/set_mode", params);
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    record("session/set_config_option", params);
    return { configOptions: [] };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    record("session/cancel", params);
    cancelled.get(params.sessionId)?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const index = previousTurns();
    record("session/prompt", params);
    const turns = scenario.turns ?? [[{ stop: "end_turn" }]];
    const steps = turns[Math.min(index, turns.length - 1)] ?? [];
    turn++;
    const controller = new AbortController();
    cancelled.set(params.sessionId, controller);
    try {
      const stop = await play(
        client,
        params.sessionId,
        steps,
        controller.signal,
        params.prompt,
      );
      if (controller.signal.aborted && !scenario.ignoreCancel)
        return { stopReason: "cancelled" };
      return { stopReason: stop ?? "end_turn" };
    } finally {
      cancelled.delete(params.sessionId);
    }
  });

const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
process.exit(0);
