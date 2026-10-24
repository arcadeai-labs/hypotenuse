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
 * | `usage_update` | `usage`: the turn's share of the agent's cumulative cost (see {@link TurnMapper.costBaseline}), and the context window |
 * | a pull request URL of the session's repository, in a completed `execute` result or the turn's message | `external_url` "Pull Request", once per URL |
 * | mode, config, and command updates; `user_message_chunk`; notices; compaction | nothing |
 * | an unknown kind | nothing; reported once |
 *
 * Once the agent has asked the person with `linear_ask_user`
 * ({@link TurnMapper.askedUser}), no further activity is emitted: the
 * question is posted by the server, and a thought, action, or `response`
 * after it would move the Linear session out of `awaitingInput` and hide the
 * question. The turn's end then emits only pull request links (session
 * updates, not activities), and any trailing message is left to the session
 * log.
 */
import type { TurnUsage } from "../../../protocol/src/index";
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
  /** The disclosure appended to the turn's response ({@link responseSignature}). */
  signature?: string;
}

/**
 * The block a turn's final response ends with: a collapsed `+++` section
 * whose title says an AI agent wrote it and in which role, and whose body
 * names the runner and the agent (Linear's AIG #1: always disclose being an
 * agent). Linear already badges the app's activities; this survives a copy.
 * @param who - The role, the agent's id, name, and version, and the runner.
 * @returns `\n\n+++ — Hypotenuse (<role>, <agent>)\n…\n+++`.
 */
export function responseSignature(who: {
  role: string;
  agentId: string;
  agentTitle: string;
  agentVersion?: string | null;
  runnerName: string;
}): string {
  const version = who.agentVersion ? ` ${who.agentVersion}` : "";
  return `\n\n+++ — Hypotenuse (${who.role}, ${who.agentTitle})\nAn AI coding agent: \`${who.agentId}\`${version} on runner \`${who.runnerName}\`, delegated through Hypotenuse.\n+++`;
}

/** One coding agent turn's mapping. */
export class TurnMapper {
  /** While true (a `session/load` replay), every update is discarded. */
  replaying = false;
  /** Once true (a stop), only `response` and `error` are emitted. */
  stopping = false;
  /** Once true (`linear_ask_user`), no activity is emitted at all. */
  askedUser = false;
  private thought = "";
  private thoughtSince = 0;
  private readonly messages = new Map<string, string>();
  private readonly calls = new Map<string, ToolCallState>();
  private lastPlan = "";
  private readonly unknown = new Set<string>();
  private lastActionSummary: string | null = null;
  /**
   * What the agent's session had cost (USD) before this turn: `0` for a new
   * ACP session, the figure the daemon recorded at the last turn's end for a
   * resumed one, or what a completed `session/load` replay reports. Null when unknown,
   * and then the turn's cost is not reported.
   */
  costBaseline: number | null = null;
  /** The last cost figure a `session/load` replay reported, until the load completes. */
  private replayedCost: number | null = null;
  /** Whether this turn's first live cost figure has been checked against the baseline. */
  private costChecked = false;
  /** The agent's cumulative cost for its session (USD), as last reported or as the baseline. */
  private sessionCost: number | null = null;
  /** What the turn has spent so far, as the next `usage` event reports it. */
  private readonly usage: TurnUsage & {
    contextUsed?: number;
    contextSize?: number;
  } = {};
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
    if (this.replaying) {
      // A replayed figure is what the session had spent before this turn,
      // once the replay is whole ({@link acceptReplay}).
      if (update.sessionUpdate === "usage_update") {
        const cost = usdCost(update.cost);
        if (cost !== null) this.replayedCost = cost;
      }
      return [];
    }
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
        this.usage.contextUsed = Math.max(0, Math.round(update.used));
        this.usage.contextSize = Math.max(0, Math.round(update.size));
        this.recordCost(usdCost(update.cost));
        return [{ type: "usage", ...this.usage }];
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
   * The `session/load` replay completed: its last cost figure, if it gave
   * one, is the baseline. A replay cut short leaves the baseline as it was,
   * so a turn taken away mid-load never records a partial figure.
   */
  acceptReplay(): void {
    if (this.replayedCost !== null) this.costBaseline = this.replayedCost;
    this.replayedCost = null;
  }

  /**
   * Take the agent's cumulative cost for its session and work out the turn's
   * share. A first figure below the baseline means the agent counts from its
   * own process's start (every turn is a new process), so the baseline is
   * `0` for the rest of the turn.
   * @param cumulative - The agent's figure in USD, or null when it gave none.
   */
  private recordCost(cumulative: number | null): void {
    if (cumulative === null) return;
    if (!this.costChecked) {
      this.costChecked = true;
      if (this.costBaseline !== null && cumulative < this.costBaseline)
        this.costBaseline = 0;
    }
    this.sessionCost = cumulative;
    if (this.costBaseline !== null)
      this.usage.costUsd = roundUsd(
        Math.max(0, cumulative - this.costBaseline),
      );
  }

  /**
   * Take the prompt response's token counts, at the turn's end.
   * @param tokens - The response's `usage`, if the agent sent one.
   * @returns The `usage` event to report, or nothing when there was nothing new.
   */
  tokens(
    tokens: { inputTokens?: number; outputTokens?: number } | undefined,
  ): EventInput[] {
    const count = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n)
        ? Math.max(0, Math.round(n))
        : undefined;
    const input = count(tokens?.inputTokens);
    const output = count(tokens?.outputTokens);
    if (input === undefined && output === undefined) return [];
    if (input !== undefined) this.usage.inputTokens = input;
    if (output !== undefined) this.usage.outputTokens = output;
    return [{ type: "usage", ...this.usage }];
  }

  /**
   * What the turn spent, for its completion; undefined when the agent
   * reported nothing.
   * @returns The tokens and cost.
   */
  turnUsage(): TurnUsage | undefined {
    const { inputTokens, outputTokens, costUsd } = this.usage;
    const usage: TurnUsage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    return Object.keys(usage).length ? usage : undefined;
  }

  /**
   * The agent's cumulative cost for its session after this turn, for the
   * next turn's baseline: the last figure it reported, else the baseline.
   * @returns USD, or null when unknown.
   */
  sessionCostUsd(): number | null {
    return this.sessionCost ?? this.costBaseline;
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
    if (!body || this.stopping || this.askedUser) return [];
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
    // The question the agent asked is the turn's answer.
    if (this.askedUser) return events;
    const where = context.branch
      ? `Progress so far is on \`${context.branch}\``
      : "Progress so far is in the working directory";
    switch (stopReason) {
      case "end_turn": {
        const last = this.lastActionSummary;
        const signature = context.signature ?? "";
        events.push({
          type: "response",
          body: `${truncate(
            said || (last ? `Done. Last step: ${last}.` : "Done."),
            60_000 - signature.length,
          )}${signature}`,
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
    if (this.stopping || this.askedUser) return [];
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

/**
 * An ACP cost in US dollars; other currencies are not converted.
 * @param cost - The `usage_update`'s `cost`.
 * @returns The amount, or null.
 */
function usdCost(
  cost: { amount: number; currency: string } | null | undefined,
): number | null {
  if (!cost || cost.currency.toUpperCase() !== "USD") return null;
  return Number.isFinite(cost.amount) ? Math.max(0, cost.amount) : null;
}

/**
 * Round to a millionth of a dollar, the precision the server keeps, so a
 * subtraction's float noise is not reported.
 * @param usd - Dollars.
 * @returns Dollars, rounded.
 */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
