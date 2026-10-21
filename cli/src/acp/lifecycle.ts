/**
 * The edges of a turn: where its agent's output is logged, what a stopped
 * turn says in Linear for each reason it stopped, and how much of the
 * working directory changed.
 *
 * Every session has a log at `<state dir>/sessions/<agentSessionId>.log`: the
 * agent's stderr and one line per JSON-RPC message (direction, method, size —
 * the contents too at `log.level = "trace"`), each line timestamped. An error
 * activity quotes at most its last 20 stderr lines, after {@link redact}:
 * stderr is where an agent is likeliest to print a key, and a Linear issue may
 * be visible to the whole workspace.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatDuration } from "../config/durations";
import type { EventInput } from "../daemon/event-sink";
import type { StopReason } from "../daemon/executor";
import { redact } from "./summarize";

/** Lines of stderr an error quotes. */
export const STDERR_TAIL_LINES = 20;

/**
 * Where a session's agent log lives.
 * @param stateDir - The daemon's state directory.
 * @param agentSessionId - The session.
 * @returns The path.
 */
export function sessionLogPath(
  stateDir: string,
  agentSessionId: number,
): string {
  return join(stateDir, "sessions", `${agentSessionId}.log`);
}

/** One session's agent log, and the stderr tail errors quote. */
export class SessionLog {
  private readonly stderrTail: string[] = [];

  /**
   * @param path - The log file.
   * @param trace - Whether to log message contents.
   */
  constructor(
    readonly path: string,
    private readonly trace: boolean,
  ) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  }

  /**
   * Append one line.
   * @param kind - What it is (`stderr`, `rpc`, `host`).
   * @param text - The line.
   */
  private write(kind: string, text: string): void {
    try {
      appendFileSync(
        this.path,
        `${new Date().toISOString()} ${kind} ${text}\n`,
        { mode: 0o600 },
      );
    } catch {
      // A full disk must not end the turn.
    }
  }

  /**
   * A line the agent wrote to stderr.
   * @param line - The line.
   */
  stderr(line: string): void {
    this.write("stderr", line);
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
  }

  /**
   * A JSON-RPC message, summarized.
   * @param summary - Direction, method, size.
   * @param message - The message (logged only at trace level).
   */
  rpc(summary: string, message: unknown): void {
    this.write(
      "rpc",
      this.trace ? `${summary} ${JSON.stringify(message)}` : summary,
    );
  }

  /**
   * Something the host did.
   * @param line - What.
   */
  note(line: string): void {
    this.write("host", line);
  }

  /**
   * The last stderr lines, redacted, for quoting.
   * @returns The lines, or an empty string.
   */
  tail(): string {
    return redact(this.stderrTail.join("\n")).trim();
  }
}

/**
 * Quote a stderr tail as a fenced block.
 * @param tail - The lines.
 * @returns ` Last output: ```…``` `, or nothing when empty.
 */
export function quoteTail(tail: string): string {
  if (!tail) return "";
  const fence = tail.includes("```") ? "~~~" : "```";
  return `\n\nLast output:\n${fence}\n${tail}\n${fence}`;
}

/** What a stopped turn's final activity needs. */
export interface StopContext {
  /** Why it stopped. */
  reason: StopReason | "timeout" | "idle";
  /** The runner's name. */
  runnerName: string;
  /** The working directory. */
  cwd: string;
  /** The branch, if any. */
  branch: string | null;
  /** What the person who stopped it said (`agents kill --reason`). */
  note?: string | null;
  /** The turn timeout (for `timeout`) or idle timeout (for `idle`), ms. */
  timeoutMs: number;
  /** Whether the turn was waiting on a person when it stopped. */
  waitingOnPerson: boolean;
  /** Files changed in the working directory, if it is a git checkout. */
  changedFiles: number | null;
}

/**
 * The activity a stopped turn ends with, by reason:
 *
 * | Reason | Final activity |
 * |---|---|
 * | `stop` | `response`: stopped at your request, and where the changes are |
 * | `delegate_removed`, `integration_revoked`, `superseded`, `revoked` | none — the server decided not to speak, or the turn is not ours |
 * | `kill`, `dashboard` | `error`: cancelled, and from where |
 * | `timeout` | `error`: stopped after the turn timeout |
 * | `idle` | `error`: waited for an answer, or the agent was silent |
 * | `drain`, `shutdown` | `error`: the runner shut down mid-turn |
 * @param ctx - The stop.
 * @returns The event, or null to say nothing.
 */
export function stopActivity(ctx: StopContext): EventInput | null {
  const changes =
    ctx.changedFiles === null
      ? ""
      : ctx.changedFiles === 0
        ? " (nothing uncommitted)"
        : ` (${ctx.changedFiles} file${ctx.changedFiles === 1 ? "" : "s"} changed, not committed)`;
  const where = ctx.branch
    ? `on branch \`${ctx.branch}\` in \`${ctx.cwd}\`${changes}`
    : `in \`${ctx.cwd}\` on runner ${ctx.runnerName}${changes}`;
  switch (ctx.reason) {
    case "stop":
      return {
        type: "response",
        body: `Stopped at your request. Changes so far are ${where}.`,
      };
    case "kill":
      return {
        type: "error",
        body: `Cancelled from runner ${ctx.runnerName} (\`hypotenuse agents kill\`)${ctx.note ? `: ${ctx.note.trim()}` : ""}. Changes so far are ${where}.`,
      };
    case "dashboard":
      return {
        type: "error",
        body: `Cancelled from the Hypotenuse dashboard. Changes so far are ${where}.`,
      };
    case "timeout":
      return {
        type: "error",
        body: `Stopped after ${formatDuration(ctx.timeoutMs)}. Reply to continue from where it left off.`,
      };
    case "idle":
      return {
        type: "error",
        body: ctx.waitingOnPerson
          ? `Waited ${formatDuration(ctx.timeoutMs)} for an answer; reply to resume.`
          : `The agent was silent for ${formatDuration(ctx.timeoutMs)}, so the turn was stopped. Reply to continue.`,
      };
    case "drain":
    case "shutdown":
      return {
        type: "error",
        body: `The runner ${ctx.runnerName} shut down mid-turn. Reply to continue (it may resume on another runner).`,
      };
    default:
      return null;
  }
}

/**
 * How many files differ from HEAD in a git checkout.
 * @param cwd - The directory.
 * @returns The count, or null when it is not a git checkout.
 */
export function changedFiles(cwd: string): number | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}
