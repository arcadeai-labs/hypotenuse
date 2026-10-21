/**
 * The machine lock: `daemon.pid` in the default state directory, whatever
 * `--state-dir` or `-c` say, so a second daemon with another config still
 * finds the first. It is JSON, `{ pid, socketPath, startedAt }`, written with
 * `O_EXCL`; `socketPath` is the running daemon's own control socket, and
 * liveness is always checked against that recorded path.
 *
 * Every combination of the two checks has exactly one outcome:
 *
 * | Recorded pid | Recorded socket | Outcome |
 * |---|---|---|
 * | not running | — | stale: remove it and retake the lock with `O_EXCL` |
 * | running, not a `hypotenuse daemon` | — | stale (the pid was reused) |
 * | a `hypotenuse daemon` | answers `status` | running |
 * | a `hypotenuse daemon` | silent, pidfile younger than 30 s | starting |
 * | a `hypotenuse daemon` | silent, pidfile 30 s or older | hung — never reclaimed |
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { socketAnswers } from "./control-client";

/** What the pidfile records. */
export interface LockRecord {
  pid: number;
  socketPath: string;
  startedAt: number;
  configPath?: string;
}

/** What a pidfile says about the daemon it names. */
export type LockState =
  | { kind: "free" }
  | { kind: "stale"; record: LockRecord | null }
  | { kind: "running"; record: LockRecord }
  | { kind: "starting"; record: LockRecord }
  | { kind: "hung"; record: LockRecord };

/** A daemon this young with a silent socket is still starting. */
export const STARTING_WINDOW_MS = 30_000;

/** How the lock looks at processes, injectable for tests. */
export interface ProcessProbe {
  /** Whether a pid is a live process. */
  alive(pid: number): boolean;
  /** Whether a live pid is a `hypotenuse daemon`. */
  isDaemon(pid: number): boolean;
  /** Whether a control socket answers. */
  answers(socketPath: string): Promise<boolean>;
}

/**
 * Whether a command line is a `hypotenuse daemon`: one argument is the
 * program (`hypotenuse`, a compiled binary, the npm bundle, or `cli.ts` in a
 * checkout) and a later one is `daemon`.
 * @param args - The process's arguments.
 * @returns True for a daemon.
 */
export function looksLikeDaemon(args: readonly string[]): boolean {
  const program = args.findIndex((arg) => {
    const base = arg.split(/[\\/]/).pop() ?? "";
    return /^hypotenuse(\.exe|\.js)?$/i.test(base) || base === "cli.ts";
  });
  return program !== -1 && args.slice(program + 1).includes("daemon");
}

/**
 * A process's arguments: `/proc/<pid>/cmdline` on Linux, `ps` elsewhere.
 * @param pid - The process.
 * @returns Its arguments, or null when it cannot be read.
 */
export function processArgs(pid: number): string[] | null {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
    }
    const out = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return out ? out.split(/\s+/) : null;
  } catch {
    return null;
  }
}

/** This machine's processes. */
export const realProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  isDaemon(pid) {
    const args = processArgs(pid);
    return args !== null && looksLikeDaemon(args);
  },
  answers: (socketPath) => socketAnswers(socketPath),
};

/**
 * Read the pidfile.
 * @param path - The pidfile.
 * @returns The record, null when it is unreadable, or undefined when absent.
 */
export function readLock(path: string): LockRecord | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const record = JSON.parse(text) as LockRecord;
    return typeof record.pid === "number" &&
      typeof record.socketPath === "string"
      ? record
      : null;
  } catch {
    return null;
  }
}

/**
 * What the pidfile says, by the table above.
 * @param path - The pidfile.
 * @param probe - How to look at processes.
 * @param now - The clock.
 * @returns The state.
 */
export async function inspectLock(
  path: string,
  probe: ProcessProbe = realProbe,
  now: () => number = Date.now,
): Promise<LockState> {
  const record = readLock(path);
  if (record === undefined) return { kind: "free" };
  if (record === null) return { kind: "stale", record: null };
  if (!probe.alive(record.pid) || !probe.isDaemon(record.pid))
    return { kind: "stale", record };
  if (await probe.answers(record.socketPath))
    return { kind: "running", record };
  return now() - record.startedAt < STARTING_WINDOW_MS
    ? { kind: "starting", record }
    : { kind: "hung", record };
}

/**
 * Write the pidfile with `O_EXCL`.
 * @param path - The pidfile.
 * @param record - What to record.
 * @returns True when this process took the lock.
 */
function writeExclusive(path: string, record: LockRecord): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Taking the lock failed: another daemon has it. */
export class LockHeld extends Error {
  /**
   * @param state - What the pidfile says.
   * @param message - What to tell the person.
   */
  constructor(
    readonly state: LockState,
    message: string,
  ) {
    super(message);
    this.name = "LockHeld";
  }
}

/**
 * The message for a lock another daemon holds.
 * @param state - The lock's state.
 * @returns What to tell the person.
 */
export function lockMessage(state: LockState): string {
  switch (state.kind) {
    case "running":
      return `a daemon is already running (pid ${state.record.pid}${state.record.configPath ? `, config ${state.record.configPath}` : ""})`;
    case "starting":
      return `another daemon is starting (pid ${state.record.pid})`;
    case "hung":
      return `daemon pid ${state.record.pid} is not responding; run \`hypotenuse daemon stop --force\``;
    default:
      return "the daemon lock is held";
  }
}

/**
 * Take the machine lock, clearing a stale one.
 * @param path - The pidfile.
 * @param record - This daemon's record.
 * @param probe - How to look at processes.
 * @throws {LockHeld} When a running, starting, or hung daemon holds it.
 */
export async function acquireLock(
  path: string,
  record: LockRecord,
  probe: ProcessProbe = realProbe,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writeExclusive(path, record)) return;
    const state = await inspectLock(path, probe);
    if (state.kind === "free") continue;
    if (state.kind !== "stale") throw new LockHeld(state, lockMessage(state));
    // Remove only the stale record we saw; a racing start may have retaken it.
    const now = readLock(path);
    if (JSON.stringify(now) === JSON.stringify(state.record)) {
      if (
        state.record?.socketPath &&
        state.record.socketPath !== record.socketPath
      ) {
        rmSync(state.record.socketPath, { force: true });
      }
      rmSync(path, { force: true });
    }
  }
  const state = await inspectLock(path, probe);
  throw new LockHeld(state, lockMessage(state));
}

/**
 * Release the lock, if this process still holds it.
 * @param path - The pidfile.
 * @param pid - This process.
 */
export function releaseLock(path: string, pid: number = process.pid): void {
  const record = readLock(path);
  if (record && record.pid === pid) rmSync(path, { force: true });
}
