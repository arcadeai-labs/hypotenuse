/**
 * Normalizes the coding CLIs' JSONL event streams into one union.
 *
 * **This file imports nothing from the backend, on purpose.** It runs inside a
 * sandbox, where `node_modules` holds whatever the agent's image ships and
 * certainly not our workspace. Everything here is plain TypeScript over plain
 * objects, which is also why its tests are pure unit tests against recorded
 * fixture streams rather than anything that boots a server.
 *
 * The vocabularies are genuinely different — Claude Code speaks in Anthropic
 * message shapes, Codex in thread/item/turn lifecycle events, Cursor in its
 * own system/assistant/tool_call stream — so the union is the smaller thing
 * they can all say, plus the raw line for anything downstream that wants more.
 */

/** Which CLI produced a stream. */
export type AgentKind = "claude_code" | "codex" | "cursor";

/** The normalized event kinds both CLIs map onto. */
export type RunnerEventType =
  | "init"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_use"
  | "tool_result"
  | "stream"
  | "result"
  | "error"
  | "daemon"
  | "unknown";

/** One normalized event, as posted to `PUT /api/sandbox/events`. */
export interface RunnerEvent {
  /** The normalized kind. */
  type: RunnerEventType;
  /** The tool involved, for `tool_use` / `tool_result`. */
  toolName?: string;
  /** Human-readable text, when the event carries any. */
  text?: string;
  /** The raw CLI line, so nothing normalization dropped is lost. */
  payload: unknown;
  /**
   * The supervisor's sequence number, stamped **when the event is queued** and
   * never again.
   *
   * Absent on a freshly parsed event and filled in by the runner before it
   * reaches the batcher. Numbering at flush time would look equivalent and is
   * not: a retried batch would be renumbered on every attempt, so the server's
   * `(jobId, seq)` uniqueness — the entire reason a retry is safe — would
   * silently stop deduplicating anything.
   */
  seq?: number;
  /**
   * When the event happened, in epoch milliseconds, stamped **when the event is
   * queued** and never again — exactly as {@link RunnerEvent.seq} is, and for a
   * related reason: re-stamping at flush time would record when we stopped
   * retrying rather than when the agent did something.
   *
   * Absent on a freshly parsed event and filled in by the runner. It is optional
   * on the wire too, because the ingest endpoint falls back to its own clock:
   * a long job outlives a deploy, so a supervisor started before this
   * field existed is still posting batches after it.
   *
   * Without it every row in a flush shares one timestamp, since the endpoint
   * inserts a whole batch in one statement and Postgres' `now()` is the
   * transaction's start — so a busy job reads as a stuck clock.
   */
  occurredAt?: number;
}

/** What a parsed `init` event told us about the run's MCP servers. */
export interface McpServerStatus {
  name: string;
  status: string;
}

/** The result of parsing one line: zero or more events, plus anything notable. */
export interface ParseResult {
  events: RunnerEvent[];
  /** The resumable conversation identifier emitted by the coding CLI. */
  sessionId?: string;
  /**
   * MCP servers the CLI reported as broken at startup.
   *
   * This is the single most important thing the parser extracts. When a
   * `--mcp-config` entry fails validation, Claude Code **skips that server and
   * exits cleanly** — so a run with a broken config looks from the outside like
   * a successful run that happened to use no tools. Left unchecked, that is a
   * silent wrong answer rather than a failure, which is the worst kind.
   */
  failedMcpServers?: McpServerStatus[];
  /** Token usage, when the line reported a total. */
  usage?: Record<string, unknown>;
  /** The run's final text, when the line was a terminal result. */
  finalText?: string;
}

/** MCP server statuses that mean the server is not usable. */
const FAILED_MCP_STATUSES = new Set(["failed", "error", "needs-auth"]);

/**
 * Coerce a value to a short display string, for the `text` field.
 * @param value - Anything a CLI put in a text-ish position.
 * @returns A string, or undefined if there was nothing to say.
 */
function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

/**
 * Read a property off an unknown object without narrowing the whole thing.
 * @param value - The candidate object.
 * @param key - The property to read.
 * @returns The value, or undefined if `value` is not an object.
 */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * The readable text of a Claude Code thinking block, or undefined when omitted.
 *
 * Newest models default `thinking.display` to `omitted` and return
 * `{ type: "thinking", thinking: "", signature: "…" }`. An empty string is not
 * a thought — it is the API saying it redacted one — so it is dropped here
 * rather than stored as `text: ""`, which the transcript would then expand
 * into a blank fold. A populated block has used both `thinking` and `text`
 * as the field name; preferring a non-empty value from either keeps a CLI
 * rename from silently emptying the transcript.
 * @param block - One content block from an assistant or user message.
 * @returns The thinking summary, or undefined when there is nothing to show.
 */
function thinkingText(block: unknown): string | undefined {
  for (const key of ["thinking", "text"] as const) {
    const value = asText(prop(block, key));
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Pull the failed MCP servers out of a Claude Code `system/init` line.
 *
 * Two shapes are checked because the CLI has used both: an explicit
 * `mcp_server_errors` array, and an `mcp_servers` array whose entries carry a
 * `status`. Reading only one of them would make this check silently stop working
 * on a CLI upgrade — and a check that silently stops working is worse than no
 * check, because the run still reports success.
 * @param line - The parsed init line.
 * @returns The servers that failed, or undefined if none did.
 */
function failedMcpServers(line: unknown): McpServerStatus[] | undefined {
  const failures: McpServerStatus[] = [];

  const explicit = prop(line, "mcp_server_errors");
  if (Array.isArray(explicit)) {
    for (const entry of explicit) {
      failures.push({
        name: String(prop(entry, "name") ?? asText(entry) ?? "unknown"),
        status: String(
          prop(entry, "error") ?? prop(entry, "status") ?? "error",
        ),
      });
    }
  }

  const servers = prop(line, "mcp_servers");
  if (Array.isArray(servers)) {
    for (const entry of servers) {
      const status = String(prop(entry, "status") ?? "");
      if (!FAILED_MCP_STATUSES.has(status.toLowerCase())) continue;
      failures.push({
        name: String(prop(entry, "name") ?? "unknown"),
        status,
      });
    }
  }

  return failures.length > 0 ? failures : undefined;
}

/**
 * Parse one line of Claude Code's `--output-format stream-json`.
 * @param line - The already-JSON-parsed line.
 * @returns The normalized events and anything notable the line carried.
 */
export function parseClaudeLine(line: unknown): ParseResult {
  const type = String(prop(line, "type") ?? "");

  if (type === "system" && prop(line, "subtype") === "init") {
    const sessionId = asText(prop(line, "session_id"));
    return {
      events: [
        {
          type: "init",
          text: sessionId,
          payload: line,
        },
      ],
      sessionId,
      failedMcpServers: failedMcpServers(line),
    };
  }

  if (type === "assistant" || type === "user") {
    const content = prop(prop(line, "message"), "content");
    const events: RunnerEvent[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = String(prop(block, "type") ?? "");
        if (blockType === "text") {
          events.push({
            type: "assistant",
            text: asText(prop(block, "text")),
            payload: block,
          });
        } else if (blockType === "thinking") {
          events.push({
            type: "reasoning",
            text: thinkingText(block),
            payload: block,
          });
        } else if (blockType === "tool_use") {
          events.push({
            type: "tool_use",
            toolName: asText(prop(block, "name")),
            text: asText(prop(block, "input")),
            payload: block,
          });
        } else if (blockType === "tool_result") {
          events.push({
            type: "tool_result",
            text: asText(prop(block, "content")),
            payload: block,
          });
        } else {
          events.push({ type: "unknown", payload: block });
        }
      }
    }

    // A message with no recognizable blocks still happened; recording it as
    // `unknown` keeps the event log a faithful transcript.
    if (events.length === 0) events.push({ type: "unknown", payload: line });
    return { events };
  }

  if (type === "stream_event") {
    return { events: [{ type: "stream", payload: line }] };
  }

  if (type === "result") {
    // `result` is the last assistant message text. The transcript stores
    // both and folds the copy at display time, because a run whose final
    // answer never arrived as an `assistant` event still needs this line.
    const isError =
      prop(line, "is_error") === true || prop(line, "subtype") !== "success";
    const text = asText(prop(line, "result"));
    return {
      events: [
        {
          type: isError ? "error" : "result",
          text,
          payload: line,
        },
      ],
      usage: (prop(line, "usage") as Record<string, unknown>) ?? undefined,
      finalText: text,
      sessionId: asText(prop(line, "session_id")),
    };
  }

  return { events: [{ type: "unknown", payload: line }] };
}

/**
 * Parse one line of Codex's `codex exec --json` output.
 * @param line - The already-JSON-parsed line.
 * @returns The normalized events and anything notable the line carried.
 */
export function parseCodexLine(line: unknown): ParseResult {
  const type = String(prop(line, "type") ?? "");

  if (type === "thread.started" || type === "turn.started") {
    const sessionId = asText(prop(line, "thread_id"));
    return {
      events: [
        {
          type: "init",
          text: sessionId,
          payload: line,
        },
      ],
      sessionId,
    };
  }

  if (type === "item.started" || type === "item.completed") {
    const item = prop(line, "item");
    const itemType = String(
      prop(item, "item_type") ?? prop(item, "type") ?? "",
    );

    if (itemType === "assistant_message" || itemType === "agent_message") {
      return {
        events: [
          {
            type: "assistant",
            text: asText(prop(item, "text")),
            payload: line,
          },
        ],
      };
    }
    if (itemType === "reasoning") {
      return {
        events: [
          {
            type: "reasoning",
            text: asText(prop(item, "text")),
            payload: line,
          },
        ],
      };
    }
    if (itemType === "command_execution" || itemType === "mcp_tool_call") {
      // `item.started` is the invocation and `item.completed` is its outcome —
      // the same split Claude Code expresses as tool_use / tool_result.
      return {
        events: [
          {
            type: type === "item.started" ? "tool_use" : "tool_result",
            toolName: asText(
              prop(item, "tool") ??
                prop(item, "command") ??
                (itemType === "command_execution" ? "shell" : "mcp"),
            ),
            text: asText(
              prop(item, "aggregated_output") ??
                prop(item, "output") ??
                prop(item, "command"),
            ),
            payload: line,
          },
        ],
      };
    }

    return { events: [{ type: "unknown", payload: line }] };
  }

  if (type === "turn.completed") {
    return {
      events: [{ type: "result", payload: line }],
      usage: (prop(line, "usage") as Record<string, unknown>) ?? undefined,
    };
  }

  if (type === "turn.failed" || type === "error") {
    const text = asText(
      prop(prop(line, "error"), "message") ?? prop(line, "message"),
    );
    return {
      events: [{ type: "error", text, payload: line }],
      finalText: text,
    };
  }

  return { events: [{ type: "unknown", payload: line }] };
}

/**
 * The first key on a Cursor `tool_call` object that names a built-in tool.
 * @param toolCall - The `tool_call` bag from a started/completed event.
 * @returns The tool name, or undefined.
 */
function cursorBuiltinToolName(toolCall: unknown): string | undefined {
  if (typeof toolCall !== "object" || toolCall === null) return undefined;
  for (const key of Object.keys(toolCall as Record<string, unknown>)) {
    if (key.endsWith("ToolCall")) return key.replace(/ToolCall$/, "");
  }
  return undefined;
}

/**
 * Parse one line of Cursor's `--output-format stream-json`.
 *
 * Init / user / assistant / result are Claude-shaped. Tool calls are not:
 * they arrive as `tool_call` started/completed events whose payload names the
 * tool as `readToolCall` / `writeToolCall` / `function`, not as a content block.
 * @param line - The already-JSON-parsed line.
 * @returns The normalized events and anything notable the line carried.
 */
export function parseCursorLine(line: unknown): ParseResult {
  const type = String(prop(line, "type") ?? "");

  if (type === "system" && prop(line, "subtype") === "init") {
    const sessionId = asText(prop(line, "session_id"));
    return {
      events: [
        {
          type: "init",
          text: sessionId,
          payload: line,
        },
      ],
      sessionId,
      failedMcpServers: failedMcpServers(line),
    };
  }

  if (type === "assistant" || type === "user") {
    // `--stream-partial-output` (which we do not pass) emits a buffered
    // flush before each tool call that repeats the text already streamed.
    // `model_call_id` is how the docs tell that copy from the real delta.
    if (prop(line, "model_call_id") !== undefined) {
      return { events: [] };
    }

    const content = prop(prop(line, "message"), "content");
    const events: RunnerEvent[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = String(prop(block, "type") ?? "");
        if (blockType === "text") {
          events.push({
            type: type === "user" ? "user" : "assistant",
            text: asText(prop(block, "text")),
            payload: block,
          });
        } else {
          events.push({ type: "unknown", payload: block });
        }
      }
    }

    if (events.length === 0) events.push({ type: "unknown", payload: line });
    return { events };
  }

  if (type === "tool_call") {
    const toolCall = prop(line, "tool_call");
    const builtin = cursorBuiltinToolName(toolCall);
    const fn = prop(toolCall, "function");
    const toolName =
      builtin ??
      asText(prop(fn, "name")) ??
      (fn !== undefined ? "function" : "tool");
    const args =
      builtin !== undefined
        ? prop(prop(toolCall, `${builtin}ToolCall`), "args")
        : prop(fn, "arguments");
    const resultBag =
      builtin !== undefined
        ? prop(prop(toolCall, `${builtin}ToolCall`), "result")
        : prop(fn, "result");
    const isStart = prop(line, "subtype") === "started";
    return {
      events: [
        {
          type: isStart ? "tool_use" : "tool_result",
          toolName,
          text: asText(isStart ? args : (resultBag ?? args)),
          payload: line,
        },
      ],
    };
  }

  if (type === "result") {
    const isError =
      prop(line, "is_error") === true || prop(line, "subtype") !== "success";
    const text = asText(prop(line, "result"));
    return {
      events: [
        {
          type: isError ? "error" : "result",
          text,
          payload: line,
        },
      ],
      usage: (prop(line, "usage") as Record<string, unknown>) ?? undefined,
      finalText: text,
      sessionId: asText(prop(line, "session_id")),
    };
  }

  return { events: [{ type: "unknown", payload: line }] };
}

/**
 * Parse one raw line from either CLI, tolerating anything that is not JSON.
 *
 * Non-JSON output is common and harmless — a CLI writing a progress line or a
 * deprecation warning to stdout — so it becomes an `unknown` event rather than
 * an error. Failing a thirty-minute run over an unparseable line would be its
 * own bug.
 * @param kind - Which CLI produced the line.
 * @param raw - The raw line, without its trailing newline.
 * @returns The normalized events and anything notable the line carried.
 */
export function parseLine(kind: AgentKind, raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { events: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { events: [{ type: "unknown", text: trimmed, payload: { raw } }] };
  }

  if (kind === "codex") return parseCodexLine(parsed);
  if (kind === "cursor") return parseCursorLine(parsed);
  return parseClaudeLine(parsed);
}

/**
 * Split a chunk of stream bytes into complete lines, keeping the partial tail.
 *
 * Stream chunks split mid-line whenever a JSON object is bigger than a socket
 * read, which for a tool result is most of the time. Parsing per chunk would
 * turn every large tool result into an `unknown` event.
 * @param buffer - Whatever was left over from the previous chunk.
 * @param chunk - The new text.
 * @returns The complete lines and the new leftover.
 */
export function splitLines(
  buffer: string,
  chunk: string,
): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
