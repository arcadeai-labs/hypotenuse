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
 *   "turns": [[<step>, ...], ...],             // turn n plays turns[min(n, last)]
 *   "roleTurns": { "manager": [[<step>, ...], ...] } }  // per HYPOTENUSE_ROLE
 *
 * Every turn is a new agent process, so "turn n" counts the prompts this
 * Hypotenuse session (`HYPOTENUSE_SESSION_ID`) already sent, from the record.
 * `roleTurns`, when it has the session's role (`HYPOTENUSE_ROLE`), is played
 * instead of `turns` — one scenario for a manager and the workers it
 * dispatches.
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
 * output is the command's), `{ "mcp": { "tool": "linear_get_issue",
 * "arguments": {} } }` (call a tool on the `hypotenuse` MCP server the
 * session was given — connected once and kept open for the turn — reported
 * as a tool call, its text said as a message, and recorded as
 * `mcp/result`), `{ "usage": { "inputTokens": n, "outputTokens": n } }`
 * (the prompt response's `usage`), and `{ "stop": "end_turn" }`.
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
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  attributes,
  encodeOtlpProtobuf,
  newSpanId,
  newTraceId,
  type OtlpRequestBySignal,
  type OtlpSignal,
  parseTraceparent,
  unixNano,
} from "../../../protocol/src/index";

type Step = Record<string, unknown>;

/** An `otel` step. */
interface OtelStep {
  protocol?: "json" | "protobuf";
  ownTrace?: boolean;
}

/**
 * Post this agent's own telemetry to the OTLP endpoint its environment names.
 * @param step - How to encode it, and whether to honour `TRACEPARENT`.
 */
async function postNativeTelemetry(step: OtelStep): Promise<void> {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) {
    record("otel/posted", { skipped: "no endpoint" });
    return;
  }
  const parent = step.ownTrace
    ? null
    : parseTraceparent(process.env.TRACEPARENT);
  const traceId = parent?.traceId ?? newTraceId();
  const spanId = newSpanId();
  const now = Date.now();
  const resource = {
    attributes: attributes({ "service.name": "fake-agent" }),
  };
  const scope = { name: "fake-agent" };
  const requests: { [S in OtlpSignal]: OtlpRequestBySignal[S] } = {
    traces: {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                {
                  traceId,
                  spanId,
                  ...(parent ? { parentSpanId: parent.spanId } : {}),
                  name: "fake.model_request",
                  kind: 3,
                  startTimeUnixNano: unixNano(now - 5),
                  endTimeUnixNano: unixNano(now),
                  attributes: attributes({
                    "gen_ai.request.model": "fake-model-1",
                    "gen_ai.usage.input_tokens": 120,
                    "gen_ai.usage.output_tokens": 45,
                  }),
                },
              ],
            },
          ],
        },
      ],
    },
    logs: {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: unixNano(now),
                  body: { stringValue: "fake.api_request" },
                  traceId,
                  spanId,
                  attributes: attributes({
                    cost_usd: 0.0042,
                    model: "fake-model-1",
                  }),
                },
                ...(process.env.OTEL_LOG_USER_PROMPTS === "1"
                  ? [
                      {
                        timeUnixNano: unixNano(now),
                        body: { stringValue: "fake.user_prompt" },
                        attributes: attributes({
                          prompt: "the person's prompt, logged natively",
                        }),
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      ],
    },
    metrics: {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: [
                {
                  name: "fake.token.usage",
                  unit: "{token}",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [{ timeUnixNano: unixNano(now), asInt: "165" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const statuses: Record<string, number> = {};
  for (const signal of ["traces", "logs", "metrics"] as const) {
    const protobuf = step.protocol === "protobuf";
    const res = await fetch(`${base}/v1/${signal}`, {
      method: "POST",
      headers: {
        "Content-Type": protobuf
          ? "application/x-protobuf"
          : "application/json",
      },
      body: protobuf
        ? new Uint8Array(encodeOtlpProtobuf(signal, requests[signal]))
        : JSON.stringify(requests[signal]),
    }).catch(() => null);
    statuses[signal] = res?.status ?? 0;
  }
  record("otel/posted", { statuses, traceId, spanId, endpoint: base });
}

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
  roleTurns?: Record<string, Step[][]>;
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
/** Each session's MCP servers, as `session/new` (or load, resume) gave them. */
const mcpServers = new Map<string, acp.McpServer[]>();
/** The connected `hypotenuse` MCP client, per session. */
const mcpClients = new Map<string, McpClient>();

/**
 * The session's `hypotenuse` MCP server, connected (once) as an agent would.
 * @param sessionId - The session.
 * @returns The client.
 */
async function hypotenuseTools(sessionId: string): Promise<McpClient> {
  const open = mcpClients.get(sessionId);
  if (open) return open;
  const server = (mcpServers.get(sessionId) ?? []).find(
    (s) => s.name === "hypotenuse",
  ) as
    | {
        command: string;
        args: string[];
        env: { name: string; value: string }[];
      }
    | undefined;
  if (!server) throw new Error("no hypotenuse MCP server in this session");
  const client = new McpClient({ name: "fake-agent", version: "1.2.3" });
  await client.connect(
    new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...(process.env as Record<string, string>),
        ...Object.fromEntries(server.env.map((e) => [e.name, e.value])),
      },
      stderr: "inherit",
    }),
  );
  mcpClients.set(sessionId, client);
  return client;
}

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

/** The `usage` the current prompt's response reports, set by a `usage` step. */
let promptUsage: Record<string, number> | null = null;

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
    } else if (step.write) {
      // An `fs/write_text_file` through the client; the outcome is said.
      const cwd = cwds.get(sessionId) ?? process.cwd();
      const { path, content } = step.write as { path: string; content: string };
      let text: string;
      try {
        await client.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: path.replaceAll("$CWD", cwd),
          content,
        });
        text = `Wrote ${path}.`;
      } catch (error) {
        text = `Write failed: ${(error as { message?: string }).message ?? String(error)}`;
      }
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
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
    } else if (step.mcp) {
      const { tool, arguments: args } = step.mcp as {
        tool: string;
        arguments?: Record<string, unknown>;
      };
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: tool,
          kind: "other",
          status: "in_progress",
          rawInput: args ?? {},
        },
      });
      const tools = await hypotenuseTools(sessionId);
      const result = await tools.callTool({
        name: tool,
        arguments: args ?? {},
      });
      const text = (result.content as { type: string; text?: string }[])
        .map((c) => c.text ?? "")
        .join("\n");
      record("mcp/result", { tool, isError: Boolean(result.isError), text });
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: result.isError ? "failed" : "completed",
          rawOutput: { output: text },
        },
      });
      if (step.say !== false) {
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${tool}: ${text}` },
          },
        });
      }
    } else if (step.echoPrompt) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `You said: ${promptText(prompt)}` },
        },
      });
    } else if (step.otel) {
      await postNativeTelemetry(step.otel as OtelStep);
    } else if (typeof step.stderr === "string") {
      process.stderr.write(`${step.stderr}\n`);
    } else if (typeof step.stdout === "string") {
      process.stdout.write(`${step.stdout}\n`);
    } else if (step.exit !== undefined) {
      await Bun.sleep(20);
      process.exit(Number(step.exit));
    } else if (step.usage) {
      promptUsage = step.usage as Record<string, number>;
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
    mcpServers.set(sessionId, params.mcpServers);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    record("session/load", params);
    checkAuth();
    cwds.set(params.sessionId, params.cwd);
    mcpServers.set(params.sessionId, params.mcpServers);
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
    mcpServers.set(params.sessionId, params.mcpServers ?? []);
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
    const turns = scenario.roleTurns?.[process.env.HYPOTENUSE_ROLE ?? ""] ??
      scenario.turns ?? [[{ stop: "end_turn" }]];
    const steps = turns[Math.min(index, turns.length - 1)] ?? [];
    turn++;
    const controller = new AbortController();
    cancelled.set(params.sessionId, controller);
    promptUsage = null;
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
      return {
        stopReason: stop ?? "end_turn",
        ...(promptUsage ? { usage: promptUsage } : {}),
      };
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
for (const open of mcpClients.values()) await open.close().catch(() => {});
process.exit(0);
