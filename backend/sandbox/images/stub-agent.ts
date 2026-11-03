/**
 * A stand-in for the coding CLIs, baked into `hypotenuse/sandbox:test` — the
 * scripted coding agent the sandbox suites run. Its first argument says which
 * CLI it plays (`stub-claude.sh` passes `claude`, `stub-codex.sh` `codex`),
 * and it speaks that CLI's contract:
 *
 * | | `claude` | `codex` |
 * |---|---|---|
 * | the task | `-p <prompt>` | `exec … <prompt>` |
 * | a follow-up | `--resume <session>` | `exec … resume <session> <prompt>` |
 * | MCP servers | `--mcp-config`, `${VAR}` headers expanded from the environment | `$CODEX_HOME/config.toml`'s `[mcp_servers.*]`, `bearer_token_env_var` read from the environment |
 * | models | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, Messages | the config's model provider (`base_url`, `env_key`), Responses, streamed |
 * | stdout | `--output-format stream-json` lines | `exec --json` lines |
 *
 * It plays a scenario written into its prompt, one directive per line:
 *
 *     STUB {"op":"status","state":"testing","message":"Running tests"}
 *     STUB {"op":"ask","question":"Which branch?","waitSeconds":30}
 *     STUB {"op":"help","question":"Who owns the deploy key?","waitSeconds":30}
 *     STUB {"op":"artifact","name":"result","content":"Tests pass on {{answer}}"}
 *     STUB {"op":"model"}
 *     STUB {"op":"mcp","server":"mail","tool":"send","args":{}}
 *     STUB {"op":"memory","query":"deploys"}
 *     STUB {"op":"sh","command":"git push -u origin HEAD"}
 *     STUB {"op":"sleep","ms":1000}
 *     STUB {"op":"hang"}
 *     STUB {"op":"fail","message":"the stub was asked to fail"}
 *     STUB {"op":"result","text":"All done."}
 *
 * Everything it reaches, it reaches the way the real CLI would: our MCP
 * server and the gateway proxy over Streamable HTTP with the job token as a
 * bearer, and models through the model proxy. A directive's failure is printed as an error result
 * and exits 2. `sh` runs a shell command in the CLI's working directory, the
 * way the real CLI's Bash tool does (as `sh -lc`, a login shell), says its
 * output, and fails the run on a non-zero exit unless `"allowFail": true`.
 */
import { readFileSync } from "node:fs";

/** One directive. */
interface Directive {
  op: string;
  [key: string]: unknown;
}

const [dialect, ...argv] = process.argv.slice(2);
if (dialect !== "claude" && dialect !== "codex") {
  console.error(`stub-agent: unknown dialect ${dialect}`);
  process.exit(64);
}
const codex = dialect === "codex";
let prompt = "";
let resume: string | null = null;
let mcpConfigPath: string | null = null;
let model: string | null = null;
if (codex) {
  // `codex exec [options] <prompt>` or `codex exec [options] resume <id> <prompt>`.
  const positional: string[] = [];
  for (let i = argv[0] === "exec" ? 1 : 0; i < argv.length; i++) {
    if (argv[i] === "--model" || argv[i] === "-m") model = argv[++i] ?? null;
    else if (!argv[i].startsWith("-")) positional.push(argv[i]);
  }
  if (positional[0] === "resume") {
    resume = positional[1] ?? null;
    prompt = positional[2] ?? "";
  } else {
    prompt = positional[0] ?? "";
  }
} else {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-p") prompt = argv[++i] ?? "";
    else if (argv[i] === "--resume") resume = argv[++i] ?? null;
    else if (argv[i] === "--mcp-config") mcpConfigPath = argv[++i] ?? null;
    else if (argv[i] === "--model") model = argv[++i] ?? null;
  }
}

const SESSION = resume ?? `stub-session-${process.pid}`;

/** Items Codex numbers as it goes. */
let itemId = 0;

/**
 * Print one JSONL line.
 * @param line - The object.
 */
function emit(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
}

/**
 * Print an assistant text line.
 * @param text - The text.
 */
function say(text: string): void {
  if (codex) {
    emit({
      type: "item.completed",
      item: { id: `item_${itemId++}`, type: "agent_message", text },
    });
    return;
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** The MCP servers the config names, with their bearer read from the environment. */
const servers: Record<
  string,
  { url: string; headers: Record<string, string> }
> = {};
/** Codex's model provider, from its config. */
let codexProvider: { baseUrl: string; envKey: string } | null = null;
if (codex) {
  const home = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  const config = Bun.TOML.parse(
    readFileSync(`${home}/config.toml`, "utf8"),
  ) as {
    model?: string;
    model_provider?: string;
    model_providers?: Record<string, { base_url: string; env_key: string }>;
    mcp_servers?: Record<
      string,
      { url: string; bearer_token_env_var?: string }
    >;
  };
  model ??= config.model ?? null;
  const provider =
    config.model_providers?.[String(config.model_provider ?? "")];
  if (provider) {
    codexProvider = { baseUrl: provider.base_url, envKey: provider.env_key };
  }
  for (const [name, s] of Object.entries(config.mcp_servers ?? {})) {
    const token = s.bearer_token_env_var
      ? process.env[s.bearer_token_env_var]
      : undefined;
    servers[name] = {
      url: s.url,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }
} else if (mcpConfigPath) {
  const raw = readFileSync(mcpConfigPath, "utf8").replace(
    /\$\{(\w+)\}/g,
    (_, name: string) => process.env[name] ?? "",
  );
  const parsed = JSON.parse(raw) as {
    mcpServers: Record<
      string,
      { url: string; headers?: Record<string, string> }
    >;
  };
  for (const [name, s] of Object.entries(parsed.mcpServers)) {
    servers[name] = { url: s.url, headers: s.headers ?? {} };
  }
}

/** Open MCP sessions, by server. */
const sessions = new Map<string, string | null>();
let rpcId = 0;

/**
 * Send one JSON-RPC message to a server and read its answer (JSON or SSE).
 * @param server - The server's name in the config.
 * @param method - The method.
 * @param params - Its params.
 * @param notification - A notification has no id and no answer.
 * @returns The `result`.
 */
async function rpc(
  server: string,
  method: string,
  params: Record<string, unknown>,
  notification = false,
): Promise<Record<string, unknown>> {
  const s = servers[server];
  if (!s) throw new Error(`no MCP server named ${server}`);
  const headers: Record<string, string> = {
    ...s.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const session = sessions.get(server);
  if (session) headers["mcp-session-id"] = session;
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++rpcId, method, params };
  const res = await fetch(s.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessions.set(server, sid);
  const text = await res.text();
  if (notification) return {};
  if (!res.ok)
    throw new Error(
      `${server} ${method}: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  const json = text.trim().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .pop() ?? "{}",
      );
  if (json.error) throw new Error(`${server} ${method}: ${json.error.message}`);
  return json.result as Record<string, unknown>;
}

/**
 * Call a tool, opening the server's session first.
 * @param server - The server.
 * @param tool - The tool.
 * @param args - Its arguments.
 * @returns The tool's text, parsed as JSON when it is.
 */
async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{
  isError: boolean;
  text: string;
  json: Record<string, unknown> | null;
}> {
  if (!sessions.has(server)) {
    await rpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: `stub-${dialect}`, version: "1.0.0" },
    });
    if (!sessions.has(server)) sessions.set(server, null);
    await rpc(server, "notifications/initialized", {}, true);
  }
  const result = await rpc(server, "tools/call", {
    name: tool,
    arguments: args,
  });
  const text = ((result.content as { text?: string }[]) ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (codex) {
    const id = `item_${itemId++}`;
    const item = { id, type: "mcp_tool_call", server, tool, arguments: args };
    emit({ type: "item.started", item: { ...item, status: "in_progress" } });
    emit({
      type: "item.completed",
      item: {
        ...item,
        result: { content: [{ type: "text", text: text.slice(0, 2000) }] },
        error: null,
        status: result.isError === true ? "failed" : "completed",
      },
    });
  } else {
    emit({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: `mcp__${server}__${tool}`, input: args },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: text.slice(0, 2000) }],
      },
    });
  }
  return { isError: result.isError === true, text, json };
}

/**
 * Wait for a question's answer, checking until it is answered or time runs out.
 * @param questionId - The question.
 * @param waitSeconds - How long to keep checking.
 * @returns The answer, or `null`.
 */
async function waitForAnswer(
  questionId: number,
  waitSeconds: number,
): Promise<string | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const r = await callTool("hypotenuse", "sandbox-check-answer", {
      questionId,
      waitMs: 2_000,
    });
    if (r.json?.status === "answered") return String(r.json.answer);
    if (r.json && r.json.status !== "pending") return null;
  }
  return null;
}

/**
 * Ask the model through the model proxy, the way the CLI would.
 * @param d - The directive: an optional `model` and `prompt`.
 * @returns The status and the body as text.
 */
async function askModel(
  d: Directive,
): Promise<{ status: number; body: string }> {
  const text = String(d.prompt ?? "Hello");
  const res = codex
    ? await fetch(`${codexProvider?.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env[codexProvider?.envKey ?? ""]}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: d.model ?? model,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          ],
          stream: true,
          store: false,
        }),
      })
    : await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: d.model ?? process.env.ANTHROPIC_MODEL,
          max_tokens: 64,
          messages: [{ role: "user", content: text }],
        }),
      });
  return { status: res.status, body: await res.text() };
}

/**
 * Print the run's terminal line: Claude Code's `result`, or Codex's
 * `turn.completed` / `turn.failed`.
 * @param ok - Whether the run succeeded.
 * @param text - The closing text, or the error.
 */
function finish(ok: boolean, text: string): void {
  if (codex) {
    if (ok) {
      emit({ type: "turn.completed", usage: codexUsage });
    } else {
      emit({ type: "turn.failed", error: { message: text } });
    }
    return;
  }
  emit({
    type: "result",
    subtype: ok ? "success" : "error_during_execution",
    is_error: !ok,
    result: text,
    session_id: SESSION,
    usage,
  });
}

process.on("SIGTERM", () => process.exit(143));

const directives: Directive[] = prompt
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("STUB "))
  .map((l) => JSON.parse(l.slice(5)) as Directive);

if (codex) {
  emit({ type: "thread.started", thread_id: SESSION });
  emit({ type: "turn.started" });
} else {
  emit({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    mcp_servers: Object.keys(servers).map((name) => ({
      name,
      status: "connected",
    })),
  });
}
say(resume ? `Following up: ${prompt.split("\n")[0]}` : "Reading the task.");

let answer = "";
let closing = resume
  ? `follow-up done: ${prompt.split("\n")[0]}`
  : "stub run complete";
const usage = { input_tokens: 12, output_tokens: 34 };
const codexUsage = {
  input_tokens: 12,
  cached_input_tokens: 0,
  output_tokens: 34,
};
try {
  for (const d of directives) {
    switch (d.op) {
      case "status":
        await callTool("hypotenuse", "sandbox-report-status", {
          state: d.state,
          message: d.message,
        });
        break;
      case "ask": {
        const r = await callTool("hypotenuse", "sandbox-ask", {
          question: d.question,
          ...(d.options ? { options: d.options } : {}),
          ...(d.blocking === false ? { blocking: false } : {}),
        });
        if (r.isError) {
          say(`ask refused: ${r.text}`);
          break;
        }
        const got = await waitForAnswer(
          Number(r.json?.questionId),
          Number(d.waitSeconds ?? 60),
        );
        answer = got ?? "no answer";
        say(`Answer: ${answer}`);
        break;
      }
      case "help": {
        const r = await callTool("hypotenuse", "sandbox-request-help", {
          question: d.question,
        });
        const got = await waitForAnswer(
          Number(r.json?.questionId),
          Number(d.waitSeconds ?? 60),
        );
        answer = got ?? "no answer";
        say(`Team answered: ${answer}`);
        break;
      }
      case "artifact":
        await callTool("hypotenuse", "sandbox-submit-artifact", {
          name: d.name,
          content: String(d.content).replace("{{answer}}", answer),
        });
        break;
      case "memory": {
        const r = await callTool("hypotenuse", "sandbox-memory-search", {
          query: d.query,
        });
        say(`Memory: ${r.text.slice(0, 500)}`);
        break;
      }
      case "mcp": {
        const r = await callTool(
          String(d.server),
          String(d.tool),
          (d.args as Record<string, unknown>) ?? {},
        );
        say(
          `${d.server}/${d.tool}${r.isError ? " refused" : ""}: ${r.text.slice(0, 500)}`,
        );
        break;
      }
      case "model": {
        const res = await askModel(d);
        say(`Model answered ${res.status}: ${res.body.slice(0, 500)}`);
        break;
      }
      case "sh": {
        const shItem = {
          id: `item_${itemId++}`,
          type: "command_execution",
          command: String(d.command),
        };
        if (codex) {
          emit({
            type: "item.started",
            item: { ...shItem, status: "in_progress" },
          });
        }
        const proc = Bun.spawn(["sh", "-lc", String(d.command)], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (codex) {
          emit({
            type: "item.completed",
            item: {
              ...shItem,
              aggregated_output: `${out}${err}`.slice(0, 4000),
              exit_code: code,
              status: code === 0 ? "completed" : "failed",
            },
          });
        }
        say(`$ ${d.command} (exit ${code})\n${out}${err}`.slice(0, 4000));
        if (code !== 0 && d.allowFail !== true) {
          throw new Error(`${d.command} exited ${code}: ${err.slice(0, 500)}`);
        }
        break;
      }
      case "sleep":
        await Bun.sleep(Number(d.ms ?? 1000));
        break;
      case "hang":
        for (;;) await Bun.sleep(5_000);
      case "fail":
        finish(false, String(d.message ?? "the stub was asked to fail"));
        process.exit(2);
        break;
      case "result":
        closing = String(d.text).replace("{{answer}}", answer);
        break;
      default:
        throw new Error(`unknown directive ${d.op}`);
    }
  }
} catch (e) {
  finish(false, e instanceof Error ? e.message : String(e));
  process.exit(2);
}

say(closing);
finish(true, closing);
process.exit(0);
