/**
 * A stand-in for the `claude` CLI, baked into `hypotenuse/sandbox:test` — the
 * scripted coding agent the sandbox suites run. It speaks the real CLI's
 * contract: the prompt in `-p`, `--resume <session>` for a follow-up,
 * `--mcp-config` naming MCP servers whose `${VAR}` headers it expands from
 * its environment, and `--output-format stream-json` lines on stdout.
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
 *     STUB {"op":"sleep","ms":1000}
 *     STUB {"op":"hang"}
 *     STUB {"op":"fail","message":"the stub was asked to fail"}
 *     STUB {"op":"result","text":"All done."}
 *
 * Everything it reaches, it reaches the way the real CLI would: our MCP
 * server and the gateway proxy over Streamable HTTP with the job token as a
 * bearer, and models through `ANTHROPIC_BASE_URL` with
 * `ANTHROPIC_AUTH_TOKEN`. A directive's failure is printed as an error result
 * and exits 2.
 */
import { readFileSync } from "node:fs";

/** One directive. */
interface Directive {
  op: string;
  [key: string]: unknown;
}

const argv = process.argv.slice(2);
let prompt = "";
let resume: string | null = null;
let mcpConfigPath: string | null = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-p") prompt = argv[++i] ?? "";
  else if (argv[i] === "--resume") resume = argv[++i] ?? null;
  else if (argv[i] === "--mcp-config") mcpConfigPath = argv[++i] ?? null;
}

const SESSION = resume ?? `stub-session-${process.pid}`;

/**
 * Print one stream-json line.
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
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** The MCP servers the config names, with `${VAR}` expanded. */
const servers: Record<
  string,
  { url: string; headers: Record<string, string> }
> = {};
if (mcpConfigPath) {
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
      clientInfo: { name: "stub-claude", version: "1.0.0" },
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

process.on("SIGTERM", () => process.exit(143));

const directives: Directive[] = prompt
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("STUB "))
  .map((l) => JSON.parse(l.slice(5)) as Directive);

emit({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  mcp_servers: Object.keys(servers).map((name) => ({
    name,
    status: "connected",
  })),
});
say(resume ? `Following up: ${prompt.split("\n")[0]}` : "Reading the task.");

let answer = "";
let closing = resume
  ? `follow-up done: ${prompt.split("\n")[0]}`
  : "stub run complete";
const usage = { input_tokens: 12, output_tokens: 34 };
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
        const res = await fetch(
          `${process.env.ANTHROPIC_BASE_URL}/v1/messages`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: d.model ?? process.env.ANTHROPIC_MODEL,
              max_tokens: 64,
              messages: [
                { role: "user", content: String(d.prompt ?? "Hello") },
              ],
            }),
          },
        );
        const body = await res.text();
        say(`Model answered ${res.status}: ${body.slice(0, 500)}`);
        break;
      }
      case "sleep":
        await Bun.sleep(Number(d.ms ?? 1000));
        break;
      case "hang":
        for (;;) await Bun.sleep(5_000);
      case "fail":
        emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: String(d.message ?? "the stub was asked to fail"),
          session_id: SESSION,
          usage,
        });
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
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: e instanceof Error ? e.message : String(e),
    session_id: SESSION,
    usage,
  });
  process.exit(2);
}

say(closing);
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: closing,
  session_id: SESSION,
  usage,
});
process.exit(0);
