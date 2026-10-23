/**
 * A repository's setup commands, run in order in a new worktree with the
 * per-session environment: each one under `setup_timeout`, its output to the
 * session log, an ephemeral "Running setup" action before it and a "Ran
 * setup" action after. The first failure stops the rest and is quoted in the
 * turn's error; the worktree is kept for inspection.
 */
import { spawn } from "node:child_process";
import type { EventInput } from "../daemon/event-sink";

/** Lines of output a failure quotes. */
export const SETUP_TAIL_LINES = 20;

/** How one command ended. */
export interface SetupCommandResult {
  command: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** The last lines of its output. */
  tail: string;
}

/** What the setup run needs. */
export interface SetupOptions {
  /** The worktree. */
  cwd: string;
  /** The whole environment. */
  env: Record<string, string>;
  /** Per command. */
  timeoutMs: number;
  /** Report an event to the session. */
  emit(event: EventInput): void;
  /** A line of output, for the session log. */
  output(line: string): void;
  /** Stops the command in flight. */
  signal?: AbortSignal;
  /** The clock. */
  now?: () => number;
}

/**
 * Seconds, the way an action's result says them.
 * @param ms - Milliseconds.
 * @returns `12s`, `2m 05s`.
 */
function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Run one shell command in its own process group. Its stderr is folded into
 * its stdout by the shell before the command starts, so the output — and the
 * tail a failure quotes — keeps the order it was written in; two pipes would
 * race.
 * @param command - The command, for `sh -c`.
 * @param options - Where, with what, for how long.
 * @returns How it ended.
 */
export function runSetupCommand(
  command: string,
  options: SetupOptions,
): Promise<SetupCommandResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const tail: string[] = [];
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `exec 2>&1\n${command}`], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let timedOut = false;
    let cancelled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) onAbort();
    let partial = "";
    const onData = (chunk: Buffer) => {
      partial += chunk.toString("utf8");
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        options.output(line);
        tail.push(line);
        if (tail.length > SETUP_TAIL_LINES) tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (partial) {
        options.output(partial);
        tail.push(partial);
        if (tail.length > SETUP_TAIL_LINES) tail.shift();
      }
      resolve({
        command,
        code,
        timedOut,
        cancelled,
        durationMs: now() - started,
        tail: tail.join("\n").trim(),
      });
    };
    child.on("error", (error) => {
      tail.push(error.message);
      finish(127);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Run every setup command in order, stopping at the first failure.
 * @param commands - The repository's `setup`.
 * @param options - Where, with what, for how long.
 * @returns The failed command, or null when all succeeded.
 */
export async function runSetup(
  commands: readonly string[],
  options: SetupOptions,
): Promise<SetupCommandResult | null> {
  for (const command of commands) {
    options.emit({
      type: "action",
      action: "Running setup",
      parameter: command,
      ephemeral: true,
    });
    options.output(`$ ${command}`);
    const result = await runSetupCommand(command, options);
    // A stopped turn says only what a stop owes; the setup's end is not that.
    if (result.cancelled) return result;
    const ok = result.code === 0 && !result.timedOut && !result.cancelled;
    options.emit({
      type: "action",
      action: ok ? "Ran setup" : "Setup failed",
      parameter: command,
      result: result.timedOut
        ? `timed out after ${seconds(result.durationMs)}`
        : ok
          ? seconds(result.durationMs)
          : `exit ${result.code ?? "signal"} after ${seconds(result.durationMs)}`,
      ephemeral: false,
    });
    if (!ok) return result;
  }
  return null;
}
