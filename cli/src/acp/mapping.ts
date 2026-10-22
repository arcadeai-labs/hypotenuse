/**
 * The ACP → Linear mapping: a state machine fed one `session/update` at a
 * time, answering with the protocol events (`thought`, `action`, `plan`,
 * `summary`, `usage`) each one produces, and at turn end with the turn's
 * `response` or `error`. It does no I/O and reads time from an injected
 * clock, so recorded update sequences test it exhaustively.
 *
 * | ACP | Emitted |
 * |---|---|
 * | `agent_thought_chunk` | buffered; an ephemeral `thought` every 3 s or 2 KB, before any other event, and the last one non-ephemeral at turn end |
 * | `agent_message_chunk` | buffered by `messageId`; the turn's `response` |
 * | `tool_call` (pending / in progress) | an ephemeral `action` with the in-progress verb |
 * | `tool_call_update` completed / failed | a persisted `action` with the done verb and a result |
 * | `plan` | the whole `plan`, unless identical to the last one sent |
 * | `session_info_update` | `summary`, one line of at most 255 characters |
 * | `usage_update` | `usage` (dashboard only) |
 * | a pull request URL of the session's repository, in a completed `execute` result or the turn's message | `external_url` "Pull Request", once per URL |
 * | mode, config, and command updates; `user_message_chunk`; notices; compaction | nothing |
 * | an unknown kind | nothing; reported once |
 */
import type { EventInput } from "../daemon/event-sink";
import type { SessionUpdate, StopReason } from "./connection";
import type { PrDetector } from "./pr-detect";
import {
  compactParameter,
  compactResult,
  failedResult,
  type ToolCallState,
  truncate,
  verb,
} from "./summarize";

/** Flush buffered thoughts after this long. */
export const THOUGHT_FLUSH_MS = 3_000;

/** Flush buffered thoughts at this size. */
export const THOUGHT_FLUSH_BYTES = 2_048;

/** Update kinds that are recorded and produce nothing. */
const SILENT_KINDS = new Set([
  "current_mode_update",
  "config_option_update",
  "available_commands_update",
  "user_message_chunk",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
]);

/** What the mapper needs from its surroundings. */
export interface MapperOptions {
  /** The worktree, for relative paths. */
  cwd: string;
  /** The clock. */
  now(): number;
  /** Called once per unknown update kind. */
  onUnknown?(kind: string): void;
  /** Finds the session's pull request URLs, if it has a repository. */
  pullRequests?: PrDetector;
  /** Called with each pull request URL found. */
  onPullRequest?(url: string): void;
}

/** What the turn's end needs to say where the work is. */
export interface FinishContext {
  /** The branch the work is on, if any. */
  branch: string | null;
}

/** One coding agent turn's mapping. */
export class TurnMapper {
  /** While true (a `session/load` replay), every update is discarded. */
  replaying = false;
  /** Once true (a stop), only `response` and `error` are emitted. */
  stopping = false;
  private thought = "";
  private thoughtSince = 0;
  private readonly messages = new Map<string, string>();
  private readonly calls = new Map<string, ToolCallState>();
  private lastPlan = "";
  private readonly unknown = new Set<string>();
  private lastActionSummary: string | null = null;
  /** The last mode or config option values the agent reported. */
  readonly recorded: Record<string, unknown> = {};

  /**
   * @param options - The worktree and the clock.
   */
  constructor(private readonly options: MapperOptions) {}

  /** A one-line description of the last action, for keepalives. */
  get lastAction(): string | null {
    return this.lastActionSummary;
  }

  /** Whether the agent has said anything for the response yet. */
  get hasMessage(): boolean {
    return [...this.messages.values()].some((m) => m.trim());
  }

  /**
   * Feed one update.
   * @param update - The `session/update` payload's `update`.
   * @returns The events it produces, in order.
   */
  update(update: SessionUpdate): EventInput[] {
    if (this.replaying) return [];
    const kind = (update as { sessionUpdate: string }).sessionUpdate;
    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return [];
        if (!this.thought) this.thoughtSince = this.options.now();
        this.thought += update.content.text;
        return this.thought.length >= THOUGHT_FLUSH_BYTES
          ? this.flushThought(true)
          : [];
      }
      case "agent_message_chunk": {
        if (update.content.type !== "text") return [];
        const id = update.messageId ?? "";
        this.messages.set(
          id,
          (this.messages.get(id) ?? "") + update.content.text,
        );
        return [];
      }
      case "tool_call": {
        const call: ToolCallState = {
          toolCallId: update.toolCallId,
          title: update.title ?? "",
          kind: update.kind ?? null,
          status: update.status ?? "pending",
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: update.content ?? [],
          locations: update.locations ?? [],
        };
        this.calls.set(call.toolCallId, call);
        return [...this.flushThought(true), ...this.actionFor(call)];
      }
      case "tool_call_update": {
        const known = this.calls.get(update.toolCallId);
        const call: ToolCallState = known ?? {
          toolCallId: update.toolCallId,
          title: "",
          kind: null,
          status: "pending",
          rawInput: undefined,
          rawOutput: undefined,
          content: [],
          locations: [],
        };
        const before = call.status;
        if (update.title) call.title = update.title;
        if (update.kind) call.kind = update.kind;
        if (update.rawInput !== undefined) call.rawInput = update.rawInput;
        if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
        if (update.content) call.content = update.content;
        if (update.locations) call.locations = update.locations;
        if (update.status) call.status = update.status;
        this.calls.set(call.toolCallId, call);
        const finished =
          (call.status === "completed" || call.status === "failed") &&
          before !== call.status;
        const started = !known && !finished;
        if (!finished && !started) return [];
        return [...this.flushThought(true), ...this.actionFor(call)];
      }
      case "plan": {
        const entries = update.entries
          .filter((e) => e.content.trim())
          .slice(0, 100)
          .map((e) => ({
            content: truncate(e.content.trim(), 1024),
            status: e.status,
          }));
        const key = JSON.stringify(entries);
        if (key === this.lastPlan) return [];
        this.lastPlan = key;
        if (this.stopping) return [];
        return [...this.flushThought(true), { type: "plan", entries }];
      }
      case "session_info_update": {
        const title = (update.title ?? "").replace(/[\r\n\0]+/g, " ").trim();
        if (!title || this.stopping) return [];
        return [{ type: "summary", title: truncate(title, 255) }];
      }
      case "usage_update": {
        return [
          {
            type: "usage",
            contextUsed: Math.max(0, Math.round(update.used)),
            contextSize: Math.max(0, Math.round(update.size)),
            ...(update.cost && update.cost.currency.toUpperCase() === "USD"
              ? { costUsd: Math.max(0, update.cost.amount) }
              : {}),
          },
        ];
      }
      case "current_mode_update":
        this.recorded.mode = update.currentModeId;
        return [];
      case "config_option_update":
        this.recorded.configOptions = update.configOptions;
        return [];
      default:
        if (!SILENT_KINDS.has(kind) && !this.unknown.has(kind)) {
          this.unknown.add(kind);
          this.options.onUnknown?.(kind);
        }
        return [];
    }
  }

  /**
   * The timer's check: flush thoughts buffered for {@link THOUGHT_FLUSH_MS}.
   * @returns An ephemeral thought, or nothing.
   */
  tick(): EventInput[] {
    if (!this.thought) return [];
    if (this.options.now() - this.thoughtSince < THOUGHT_FLUSH_MS) return [];
    return this.flushThought(true);
  }

  /**
   * Flush whatever thought is buffered.
   * @param ephemeral - Whether the next activity replaces it.
   * @returns The thought, or nothing.
   */
  flushThought(ephemeral: boolean): EventInput[] {
    const body = this.thought.trim();
    this.thought = "";
    if (!body || this.stopping) return [];
    return [{ type: "thought", body: truncate(body, 60_000), ephemeral }];
  }

  /**
   * The text the agent said this turn.
   * @returns The messages, in the order they started, blank-line separated.
   */
  message(): string {
    return [...this.messages.values()]
      .map((m) => m.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * The events that end a turn, from `session/prompt`'s stop reason. A
   * `cancelled` turn ends on the stop path instead, so it produces only the
   * thought flush here.
   * @param stopReason - Why the agent stopped.
   * @param context - Where the work is.
   * @returns The final events.
   */
  finish(stopReason: StopReason, context: FinishContext): EventInput[] {
    const events = this.flushThought(false);
    const said = this.message();
    events.push(...this.pullRequests(said));
    const where = context.branch
      ? `Progress so far is on \`${context.branch}\``
      : "Progress so far is in the working directory";
    switch (stopReason) {
      case "end_turn": {
        const last = this.lastActionSummary;
        events.push({
          type: "response",
          body: truncate(
            said || (last ? `Done. Last step: ${last}.` : "Done."),
            60_000,
          ),
        });
        break;
      }
      case "refusal":
        events.push({
          type: "error",
          body: `The agent declined to continue: ${truncate(said || "no reason given", 4_000)}`,
        });
        break;
      case "max_tokens":
        events.push({
          type: "error",
          body: `The agent ran out of output tokens. ${where}; reply to continue.`,
        });
        break;
      case "max_turn_requests":
        events.push({
          type: "error",
          body: "The agent hit its per-turn request limit. Reply to continue.",
        });
        break;
      default:
        break;
    }
    return events;
  }

  /**
   * `external_url` events for the pull requests in some text.
   * @param text - Tool output or the agent's message.
   * @returns One event per new pull request.
   */
  private pullRequests(text: string): EventInput[] {
    const detector = this.options.pullRequests;
    if (!detector || !text || this.stopping) return [];
    return detector.scan(text).map((link) => {
      this.options.onPullRequest?.(link.url);
      return { type: "external_url", label: link.label, url: link.url };
    });
  }

  /**
   * The action event for a tool call's current status.
   * @param call - The tool call.
   * @returns The event, or nothing while stopping.
   */
  private actionFor(call: ToolCallState): EventInput[] {
    const done = call.status === "completed" || call.status === "failed";
    const parameter = compactParameter(call, this.options.cwd);
    const action = verb(call, done);
    this.lastActionSummary = `${action} ${parameter}`;
    if (this.stopping) return [];
    if (!done) return [{ type: "action", action, parameter, ephemeral: true }];
    const result =
      call.status === "failed"
        ? failedResult(call)
        : compactResult(call, this.options.cwd);
    const links =
      call.status === "completed" && call.kind === "execute"
        ? this.pullRequests(callText(call))
        : [];
    return [
      ...links,
      {
        type: "action",
        action,
        parameter,
        ...(result ? { result } : {}),
        ephemeral: false,
      },
    ];
  }
}

/**
 * Everything a tool call printed, uncut: its text content and raw output.
 * @param call - The tool call.
 * @returns The text.
 */
function callText(call: ToolCallState): string {
  const parts: string[] = [];
  for (const item of call.content) {
    if (item.type === "content" && item.content.type === "text")
      parts.push(item.content.text);
  }
  if (call.rawOutput !== undefined && call.rawOutput !== null)
    parts.push(
      typeof call.rawOutput === "string"
        ? call.rawOutput
        : JSON.stringify(call.rawOutput),
    );
  return parts.join("\n");
}
