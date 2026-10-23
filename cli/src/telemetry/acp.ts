/**
 * The ACP host's telemetry: what one turn's conversation with its agent
 * becomes in the turn's trace. The host calls this at each step; with no
 * telemetry for the turn every call is a no-op, so the host never branches.
 *
 * | ACP | Telemetry |
 * |---|---|
 * | the process | `agent.spawn`, open from spawn to exit: command (content), pid, preset, version, exit code |
 * | `initialize`, `authenticate`, `session/new` · `load` · `resume` | a span each |
 * | `session/prompt` | `acp.prompt`, the whole turn: prompt sizes (the prompt itself at `content`), `stopReason` |
 * | `tool_call` → `tool_call_update` | a `tool_call` span from start to completed/failed: id, kind, title and input/output at `content` |
 * | thought and message chunks | `agent.thought` / `agent.message` events on `acp.prompt`, joined: sizes, and text at `content` |
 * | `plan`, `usage_update`, mode and session-info updates | events on `acp.prompt` |
 * | `session/request_permission` | `permission.wait`: the tool, the options, the policy's or the person's answer, the wait |
 * | `fs/read_text_file`, `fs/write_text_file` | `fs.read` / `fs.write`: the worktree-relative path, bytes, refusals |
 * | `elicitation/create` | `elicitation.wait` |
 * | every JSON-RPC frame | a log record at `full` |
 * | stderr | a log record at `content` |
 */
import { isAbsolute, relative } from "node:path";
import { newSpanId } from "../../../protocol/src/index";
import type { SessionUpdate } from "../acp/connection";
import type { SpanHandle, TurnTelemetry } from "./collector";

/** An attribute value. */
type Scalar = string | number | boolean | null | undefined;

/** A turn's ACP telemetry. */
export class AcpTelemetry {
  private readonly tools = new Map<string, SpanHandle>();
  private spawn: SpanHandle | null = null;
  private prompt: SpanHandle | null = null;
  /** Thought or message text arriving in chunks, joined until the kind changes. */
  private chunk: { kind: "thought" | "message"; text: string } | null = null;
  /**
   * The `acp.prompt` span's id, reserved before the agent starts: its
   * `TRACEPARENT`, which agents that honour it parent their own spans on.
   */
  readonly promptSpanId = newSpanId();

  /**
   * @param turn - The turn's telemetry, or null when it has none.
   * @param cwd - Where the turn works, for worktree-relative paths.
   */
  constructor(
    readonly turn: TurnTelemetry | null,
    public cwd: string,
  ) {}

  /** The `TRACEPARENT` an agent starts with: the `acp.prompt` span. */
  get traceparent(): string | null {
    return this.turn?.traceparentFor(this.promptSpanId) ?? null;
  }

  /**
   * A path as the trace shows it: relative to the worktree when inside it.
   * @param path - An absolute path.
   * @returns The path.
   */
  private rel(path: string): string {
    if (!isAbsolute(path)) return path;
    const r = relative(this.cwd, path);
    return r.startsWith("..") ? path : r || ".";
  }

  /**
   * Start a span under the prompt (while it runs) or the turn.
   * @param name - The span.
   * @param attrs - Its attributes.
   * @returns The span, or null without telemetry.
   */
  begin(name: string, attrs: Record<string, Scalar> = {}): SpanHandle | null {
    return this.turn?.span(name, attrs, this.prompt) ?? null;
  }

  /**
   * Run a step as a span.
   * @param name - The span.
   * @param attrs - Its attributes.
   * @param fn - The step.
   * @returns What it returns.
   */
  async around<T>(
    name: string,
    attrs: Record<string, Scalar>,
    fn: (span: SpanHandle | null) => Promise<T>,
  ): Promise<T> {
    const span = this.begin(name, attrs);
    try {
      return await fn(span);
    } catch (error) {
      span?.fail(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      span?.end();
    }
  }

  /**
   * The agent process started.
   * @param attrs - Command, pid, preset.
   * @param command - The command line (content).
   */
  spawned(attrs: Record<string, Scalar>, command: string): void {
    this.spawn = this.begin("agent.spawn", attrs);
    this.spawn?.content("agent.command", command);
  }

  /**
   * What `initialize` said about the agent.
   * @param attrs - Name, version, capabilities.
   */
  initialized(attrs: Record<string, Scalar>): void {
    this.spawn?.set(attrs);
  }

  /**
   * The agent process is gone.
   * @param exitCode - Its exit code, or null for a signal.
   */
  exited(exitCode: number | null | undefined): void {
    this.spawn?.end({ "process.exit.code": exitCode ?? null });
  }

  /**
   * `session/prompt` is sent.
   * @param attrs - Sizes of what was assembled.
   * @param text - The assembled prompt (content).
   */
  promptStarted(attrs: Record<string, Scalar>, text: string): void {
    if (!this.turn) return;
    this.prompt = this.turn.span(
      "acp.prompt",
      { "gen_ai.operation.name": "invoke_agent", ...attrs },
      null,
      "client",
      this.promptSpanId,
    );
    this.prompt.content("prompt", text);
    this.turn.promptSpan = this.prompt;
  }

  /**
   * `session/prompt` answered, or the turn stopped.
   * @param attrs - The stop reason and token usage.
   * @param error - Why it failed, if it did.
   */
  promptEnded(attrs: Record<string, Scalar>, error?: string | null): void {
    this.flushChunk();
    for (const [, span] of this.tools)
      span.end({ "hypotenuse.tool.finished": false });
    this.tools.clear();
    if (error) this.prompt?.fail(error);
    this.prompt?.end(attrs);
    if (this.turn) this.turn.promptSpan = null;
    const input = attrs["gen_ai.usage.input_tokens"];
    const output = attrs["gen_ai.usage.output_tokens"];
    if (typeof input === "number" || typeof output === "number")
      this.turn?.usage({
        inputTokens: typeof input === "number" ? input : undefined,
        outputTokens: typeof output === "number" ? output : undefined,
      });
  }

  /** Emit the joined thought or message text as one event. */
  private flushChunk(): void {
    const chunk = this.chunk;
    this.chunk = null;
    if (!chunk || !this.prompt || !this.turn) return;
    this.prompt.event(
      `agent.${chunk.kind}`,
      this.turn.contentAttrs("text", chunk.text),
    );
  }

  /**
   * One `session/update`.
   * @param update - The update.
   */
  update(update: SessionUpdate): void {
    if (!this.turn || !this.prompt) return;
    const u = update as SessionUpdate & Record<string, unknown>;
    const kind = String(u.sessionUpdate);
    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
      const content = u.content as { type?: string; text?: string };
      if (content?.type !== "text") return;
      const which = kind === "agent_thought_chunk" ? "thought" : "message";
      if (this.chunk && this.chunk.kind !== which) this.flushChunk();
      this.chunk ??= { kind: which, text: "" };
      this.chunk.text += content.text ?? "";
      return;
    }
    this.flushChunk();
    switch (kind) {
      case "tool_call": {
        const id = String(u.toolCallId);
        const span = this.turn.span(
          "tool_call",
          {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.call.id": id,
            "gen_ai.tool.type": typeof u.kind === "string" ? u.kind : null,
            "hypotenuse.tool.status":
              typeof u.status === "string" ? u.status : "pending",
          },
          this.prompt,
        );
        span.content(
          "tool.title",
          typeof u.title === "string" ? u.title : null,
        );
        this.toolDetail(span, u);
        this.tools.set(id, span);
        if (u.status === "completed" || u.status === "failed")
          this.endTool(id, u);
        return;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId);
        const span = this.tools.get(id);
        if (!span) return;
        if (typeof u.kind === "string")
          span.set({ "gen_ai.tool.type": u.kind });
        if (typeof u.title === "string") span.content("tool.title", u.title);
        this.toolDetail(span, u);
        if (u.status === "completed" || u.status === "failed")
          this.endTool(id, u);
        return;
      }
      case "plan": {
        const entries = (u.entries ?? []) as {
          content: string;
          status: string;
        }[];
        this.prompt.event("plan", {
          "hypotenuse.plan.entries": entries.length,
          "hypotenuse.plan.completed": entries.filter(
            (e) => e.status === "completed",
          ).length,
          ...this.turn.contentAttrs("plan", JSON.stringify(entries)),
        });
        return;
      }
      case "usage_update": {
        const cost = u.cost as { amount?: number; currency?: string } | null;
        this.prompt.event("usage", {
          "hypotenuse.context.used": typeof u.used === "number" ? u.used : null,
          "hypotenuse.context.size": typeof u.size === "number" ? u.size : null,
          "hypotenuse.usage.cost": cost?.amount ?? null,
          "hypotenuse.usage.currency": cost?.currency ?? null,
        });
        return;
      }
      case "current_mode_update":
        this.prompt.event("mode", {
          "hypotenuse.mode":
            typeof u.currentModeId === "string" ? u.currentModeId : null,
        });
        return;
      default:
        this.prompt.event("session_update", { "hypotenuse.update.kind": kind });
    }
  }

  /**
   * Record a tool call's locations, input, and output.
   * @param span - The tool span.
   * @param u - The update.
   */
  private toolDetail(span: SpanHandle, u: Record<string, unknown>): void {
    const locations = Array.isArray(u.locations)
      ? (u.locations as { path?: string }[])
      : null;
    if (locations?.length)
      span.set({
        "hypotenuse.tool.locations": locations
          .map((l) => (l.path ? this.rel(l.path) : ""))
          .filter(Boolean)
          .join(","),
      });
    if (u.rawInput !== undefined)
      span.content("tool.input", JSON.stringify(u.rawInput));
    if (u.rawOutput !== undefined)
      span.content("tool.output", JSON.stringify(u.rawOutput));
    else if (Array.isArray(u.content) && u.content.length)
      span.content("tool.output", JSON.stringify(u.content));
  }

  /**
   * End a tool call's span.
   * @param id - The tool call.
   * @param u - The update that finished it.
   */
  private endTool(id: string, u: Record<string, unknown>): void {
    const span = this.tools.get(id);
    this.tools.delete(id);
    if (!span) return;
    if (u.status === "failed") span.fail("the tool call failed");
    span.end({ "hypotenuse.tool.status": String(u.status) });
  }

  /**
   * A permission request is being decided.
   * @param toolCall - The tool asking.
   * @param policy - The role's policy.
   * @param options - The options offered.
   * @returns End the span with the answer.
   */
  permission(
    toolCall: {
      toolCallId: string;
      kind?: string | null;
      title?: string | null;
    },
    policy: string,
    options: { optionId: string; kind?: string }[],
  ): (answer: {
    outcome: string;
    optionId?: string;
    decidedBy: string;
  }) => void {
    const parent = this.tools.get(toolCall.toolCallId) ?? this.prompt;
    const span =
      this.turn?.span(
        "permission.wait",
        {
          "gen_ai.tool.call.id": toolCall.toolCallId,
          "gen_ai.tool.type": toolCall.kind ?? null,
          "hypotenuse.permission.policy": policy,
          "hypotenuse.permission.options": options
            .map((o) => o.kind ?? o.optionId)
            .join(","),
        },
        parent,
      ) ?? null;
    span?.content("tool.title", toolCall.title ?? null);
    return (answer) =>
      span?.end({
        "hypotenuse.permission.outcome": answer.outcome,
        "hypotenuse.permission.option": answer.optionId ?? null,
        "hypotenuse.permission.decided_by": answer.decidedBy,
      });
  }

  /**
   * A file operation the agent asked the daemon for.
   * @param op - `read` or `write`.
   * @param path - The path.
   * @returns End the span with its size, or its refusal.
   */
  fs(
    op: "read" | "write",
    path: string,
  ): (result: { bytes?: number; refused?: string }) => void {
    const span = this.begin(`fs.${op}`, { "file.path": this.rel(path) });
    return (result) => {
      if (result.refused) span?.fail(result.refused);
      span?.end({
        "hypotenuse.fs.bytes": result.bytes ?? null,
        "hypotenuse.fs.refused": result.refused ?? null,
      });
    };
  }

  /**
   * One JSON-RPC frame.
   * @param line - The trace line (`->` or `<-` first).
   * @param message - The frame.
   */
  frame(line: string, message: unknown): void {
    this.turn?.frame(line, message, this.prompt);
  }

  /**
   * One line of the agent's stderr.
   * @param line - The line.
   */
  stderr(line: string): void {
    this.turn?.log({
      body: line,
      level: "content",
      eventName: "agent.stderr",
      severity: "warn",
      span: this.spawn,
    });
  }
}
