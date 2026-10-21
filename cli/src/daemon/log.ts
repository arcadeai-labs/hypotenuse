/**
 * The daemon's log: one line per entry, `<ISO time> <level> <message>` with
 * `key=value` fields after it, appended to the log file (rotated at 10 MB,
 * five kept) and, in the foreground, echoed to stderr. A turn's lines carry
 * `session=<agentSessionId>`, which is what `daemon logs --session` filters on.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LogLevel } from "../config/schema";

/** Rotate when the file reaches this size. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** Rotated files kept: `daemon.log.1` … `daemon.log.5`. */
export const LOG_KEEP = 5;

/** Each level's rank; a line is written when its rank is at most the threshold's. */
const RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** Extra fields on a line. */
export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/** The daemon's logger. */
export class DaemonLog {
  private bytes = 0;

  /**
   * @param file - The log file, or null for stderr only.
   * @param level - The threshold.
   * @param echo - Whether lines also go to stderr.
   */
  constructor(
    readonly file: string | null,
    public level: LogLevel,
    private readonly echo: boolean,
  ) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      this.bytes = existsSync(file) ? statSync(file).size : 0;
    }
  }

  /**
   * Whether a level is written.
   * @param level - The level.
   * @returns True when it is at or above the threshold.
   */
  enabled(level: LogLevel): boolean {
    return RANK[level] <= RANK[this.level];
  }

  /**
   * Write one line.
   * @param level - Its level.
   * @param message - The message.
   * @param fields - `key=value` fields.
   */
  write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (!this.enabled(level)) return;
    const extra = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(
        ([k, v]) =>
          `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : v}`,
      )
      .join(" ");
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${extra ? ` ${extra}` : ""}\n`;
    if (this.echo) process.stderr.write(line);
    if (!this.file) return;
    try {
      if (this.bytes + line.length > LOG_ROTATE_BYTES) this.rotate();
      const fresh = !existsSync(this.file);
      appendFileSync(this.file, line, { mode: 0o600 });
      if (fresh) chmodSync(this.file, 0o600);
      this.bytes += Buffer.byteLength(line);
    } catch {
      // A full disk must not take the daemon down with it.
    }
  }

  /** Shift `daemon.log` → `.1` → … → `.5`, dropping the oldest. */
  private rotate(): void {
    if (!this.file) return;
    rmSync(`${this.file}.${LOG_KEEP}`, { force: true });
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`))
        renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    this.bytes = 0;
  }

  /**
   * @param message - The message.
   * @param fields - Fields.
   */
  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  /**
   * @param message - The message.
   * @param fields - Fields.
   */
  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  /**
   * @param message - The message.
   * @param fields - Fields.
   */
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  /**
   * @param message - The message.
   * @param fields - Fields.
   */
  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }
}
