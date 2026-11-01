/**
 * Running a background command inside a sandbox by keeping every fact about it
 * **in the sandbox**, and reading those facts back over the provider's own
 * "run a shell command" primitive.
 *
 * This is the mechanism {@link Sandbox.attach} rests on, and the reason it works
 * is that the handle holds no in-memory state at all: the wrapper script writes
 * `pid`, `stdout`, `stderr`, and `exit` into a directory named after the handle,
 * and a handle is nothing but that directory's name. A worker that restarts
 * mid-run reconnects to the sandbox, names the directory, and carries on — which
 * is what a thirty-minute run outliving a deploy actually requires.
 *
 * It lives here rather than in one provider because two of them need it and the
 * only thing that differs is the transport: `docker` runs the script with
 * `docker exec`, and `kubernetes` runs it over the API server's exec
 * subresource. Both hand in a {@link ShellRunner} and get the same semantics —
 * including the two that were learned the hard way and would otherwise have been
 * copied by eye:
 *
 * - **Output is base64-encoded inside the sandbox.** The three values share one
 *   line-delimited response, and any plain delimiter would be forgeable by the
 *   very command whose output is being read.
 * - **An `exit` event is emitted only once a poll that saw the exit code also
 *   drained both streams**, so the last chunk written just before the process
 *   exited is never dropped.
 */

import { randomBytes } from "node:crypto";
import type { ExecEvent, ExecHandle } from "../types";

/** Where a provider keeps its per-handle bookkeeping inside a sandbox. */
export const SANDBOX_STATE_DIR = "/tmp/hypotenuse";

/** How often {@link PollingExecHandle.events} polls for new output. */
export const POLL_INTERVAL_MS = 200;

/**
 * Quote a string for safe interpolation into a `/bin/sh -c` script.
 * @param value - The raw string.
 * @returns The single-quoted, shell-safe form.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A fresh handle id, which is also its state directory's name.
 * @returns An id of the form `cmd-<16 hex>`.
 */
export function newHandleId(): string {
  return `cmd-${randomBytes(8).toString("hex")}`;
}

/**
 * The state directory a handle's files live in.
 * @param handleId - The handle id.
 * @returns An absolute path inside the sandbox.
 */
export function handleStateDir(handleId: string): string {
  return `${SANDBOX_STATE_DIR}/${handleId}`;
}

/**
 * Run one shell script inside a sandbox and collect what it printed.
 *
 * The one thing a provider must supply. A non-zero `exitCode` is read as **the
 * sandbox is unreachable**, not as the script having failed — every script this
 * module generates ends in a successful `echo` — which is what turns a destroyed
 * container or a deleted pod into an `exit 137` rather than a stall.
 */
export type ShellRunner = (
  script: string,
) => Promise<{ exitCode: number; stdout: string }>;

/**
 * The wrapper a background command runs under.
 *
 * `wait $!` rather than backgrounding the whole script: the pid must be readable
 * immediately, and the exit code must be written by the same shell that owns the
 * child. The `cd` is a separate step from the redirection so a caller's working
 * directory not existing fails the command rather than the bookkeeping.
 * @param handleId - The handle id, which names the state directory.
 * @param commandLine - The already-quoted command and its arguments.
 * @param cwd - Working directory to run in, if any.
 * @returns A `/bin/sh` script.
 */
export function spawnScript(
  handleId: string,
  commandLine: string,
  cwd?: string,
): string {
  const dir = handleStateDir(handleId);
  return [
    `mkdir -p ${dir}`,
    cwd ? `cd ${shellQuote(cwd)} || exit 127` : "",
    `${commandLine} >${dir}/stdout 2>${dir}/stderr &`,
    `echo $! >${dir}/pid`,
    "wait $!",
    `echo $? >${dir}/exit`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Read new bytes from both streams plus the exit code, in one round trip.
 * @param handleId - The handle id.
 * @param outOffset - 1-based byte offset to resume stdout from.
 * @param errOffset - 1-based byte offset to resume stderr from.
 * @returns A `/bin/sh` script printing three lines: stdout delta, stderr delta,
 *   exit code — the first two base64, the third empty while still running.
 */
export function pollScript(
  handleId: string,
  outOffset: number,
  errOffset: number,
): string {
  const dir = handleStateDir(handleId);
  return [
    `O=$(tail -c +${outOffset} ${dir}/stdout 2>/dev/null | base64 | tr -d '\\n')`,
    `E=$(tail -c +${errOffset} ${dir}/stderr 2>/dev/null | base64 | tr -d '\\n')`,
    `X=$(cat ${dir}/exit 2>/dev/null)`,
    `echo "$O"`,
    `echo "$E"`,
    `echo "$X"`,
  ].join("\n");
}

/**
 * Print a handle's pid, or nothing if the wrapper has not recorded it yet.
 * @param handleId - The handle id.
 * @returns A `/bin/sh` script.
 */
export function pidScript(handleId: string): string {
  return `cat ${handleStateDir(handleId)}/pid 2>/dev/null`;
}

/**
 * Signal a handle's process, tolerating one that has already exited.
 * @param handleId - The handle id.
 * @param signal - The signal to send.
 * @returns A `/bin/sh` script that always succeeds.
 */
export function killScript(
  handleId: string,
  signal: "SIGTERM" | "SIGKILL",
): string {
  const name = signal === "SIGKILL" ? "KILL" : "TERM";
  const dir = handleStateDir(handleId);
  return `kill -${name} $(cat ${dir}/pid 2>/dev/null) 2>/dev/null || true`;
}

/**
 * Test whether a handle's state directory exists, for {@link Sandbox.attach}.
 * @param handleId - The handle id.
 * @returns A `/bin/sh` script whose exit code answers the question.
 */
export function attachProbeScript(handleId: string): string {
  return `test -d ${shellQuote(handleStateDir(handleId))}`;
}

/** What one {@link pollScript} round trip found. */
export interface PollFrame {
  /** New stdout bytes since the requested offset. */
  stdout: Buffer;
  /** New stderr bytes since the requested offset. */
  stderr: Buffer;
  /** The command's exit code, or `null` while it is still running. */
  exitCode: number | null;
}

/**
 * Decode the three lines {@link pollScript} prints.
 *
 * A missing or unparseable exit line reads as "still running" rather than as
 * zero: the wrapper writes that file exactly once, after `wait` returns, so
 * anything else in it is a partial read and treating it as a clean exit would
 * end the stream early with the wrong answer.
 * @param raw - The script's stdout.
 * @returns The decoded frame.
 */
export function parsePollFrame(raw: string): PollFrame {
  const [out = "", err = "", code = ""] = raw.split("\n");
  const parsed = Number.parseInt(code.trim(), 10);
  return {
    stdout: Buffer.from(out, "base64"),
    stderr: Buffer.from(err, "base64"),
    exitCode: Number.isNaN(parsed) ? null : parsed,
  };
}

/**
 * A command running inside a sandbox, observed entirely through
 * {@link ShellRunner}.
 *
 * Output is polled rather than streamed, and that is deliberate on both
 * providers: `docker logs` only carries a container's *main* process rather than
 * an `exec`'d one, the Kubernetes pod log carries the same and no `exec` output
 * at all, and busybox's `tail -f` has no portable "stop when this other file
 * appears". Polling costs one round trip every {@link POLL_INTERVAL_MS} and is
 * correct.
 */
export class PollingExecHandle implements ExecHandle {
  readonly id: string;
  private readonly run: ShellRunner;

  /**
   * @param handleId - The handle id, which names the state directory.
   * @param run - How to run a shell script inside the sandbox.
   */
  constructor(handleId: string, run: ShellRunner) {
    this.id = handleId;
    this.run = run;
  }

  /**
   * One poll round trip.
   * @param outOffset - 1-based byte offset to resume stdout from.
   * @param errOffset - 1-based byte offset to resume stderr from.
   * @returns The frame, plus whether the sandbox answered at all.
   */
  private async poll(
    outOffset: number,
    errOffset: number,
  ): Promise<PollFrame & { alive: boolean }> {
    const result = await this.run(
      pollScript(this.id, outOffset, errOffset),
    ).catch(() => ({ exitCode: 1, stdout: "" }));

    if (result.exitCode !== 0) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: null,
        alive: false,
      };
    }

    return { ...parsePollFrame(result.stdout), alive: true };
  }

  /**
   * Stream the command's output incrementally, ending with an `exit` event.
   *
   * A vanished sandbox also ends the stream — with exit code 137, the code a
   * SIGKILLed process reports — rather than hanging forever. A run whose sandbox
   * was destroyed out from under it did fail, and saying so beats a stall the
   * reaper has to clean up.
   * @param signal - Abort to stop iterating; the command keeps running.
   * @returns An async iterable of {@link ExecEvent}.
   */
  async *events(signal?: AbortSignal): AsyncIterable<ExecEvent> {
    const pid = await this.run(pidScript(this.id))
      .then((r) => r.stdout.trim())
      .catch(() => "");
    yield pid === "" ? { type: "start" } : { type: "start", pid };

    let outOffset = 1;
    let errOffset = 1;

    while (!signal?.aborted) {
      const { stdout, stderr, exitCode, alive } = await this.poll(
        outOffset,
        errOffset,
      );

      if (stdout.length > 0) {
        outOffset += stdout.length;
        yield { type: "stdout", data: stdout.toString("utf8") };
      }
      if (stderr.length > 0) {
        errOffset += stderr.length;
        yield { type: "stderr", data: stderr.toString("utf8") };
      }

      if (!alive) {
        yield { type: "exit", exitCode: 137 };
        return;
      }

      // Only stop once a poll that saw the exit code also drained both streams,
      // so the last chunk written just before exit is never dropped.
      if (exitCode !== null && stdout.length === 0 && stderr.length === 0) {
        yield { type: "exit", exitCode };
        return;
      }

      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Wait for the command to exit.
   * @returns The exit code, or 137 if the sandbox disappeared first.
   */
  async wait(): Promise<{ exitCode: number }> {
    for (;;) {
      const { exitCode, alive } = await this.poll(1, 1);
      if (!alive) return { exitCode: 137 };
      if (exitCode !== null) return { exitCode };
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Signal the command inside the sandbox.
   * @param signal - `SIGTERM` (default) or `SIGKILL`.
   */
  async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    await this.run(killScript(this.id, signal));
  }
}
