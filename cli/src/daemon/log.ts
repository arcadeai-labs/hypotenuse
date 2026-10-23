/**
 * The daemon's log: one line per entry, `<ISO time> <level> <message>` with
 * `key=value` fields after it, appended to the log file (rotated at 10 MB,
 * five kept) and, in the foreground, echoed to stderr. A turn's lines carry
 * `session=<agentSessionId>`, which is what `daemon logs --session` filters on.
 *
 * The file is always plain text. What reaches a terminal — the foreground
 * echo and `daemon logs` — is painted by `paintLogLine` with the CLI's theme.
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
import { createTheme, type Token } from "../output/theme";
import { getMode, isTruthyEnv, type OutputMode } from "../output/tty";

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

/** Each level's color on a terminal. */
const LEVEL_TOKEN: Record<LogLevel, Token> = {
  error: "status-error",
  warn: "status-waiting",
  info: "status-active",
  debug: "text-tertiary",
  trace: "text-tertiary",
};

/** A written line: time, padded level, then the rest. */
const LINE = /^(\S+) (error|warn |info |debug|trace) (.*)$/;

/** A `key=value` field's key, after a space. */
const FIELD_KEY = / ([A-Za-z][\w.]*)=/g;

/**
 * Paint one plain log line for a terminal: the time faint, the level in its
 * status color, an error's or warning's message in that color, a debug or
 * trace message faint, and each field's key faint. A line that is not the
 * log's format (an agent's stderr in a session log) comes back unchanged, as
 * does every line when the mode has no color.
 * @param line - The line, without its newline.
 * @param mode - The output mode; this process's by default.
 * @returns The painted line.
 */
export function paintLogLine(
  line: string,
  mode: OutputMode = getMode(),
): string {
  if (mode.depth === "none") return line;
  const match = LINE.exec(line);
  if (!match) return line;
  const [, time = "", padded = "", rest = ""] = match;
  const level = padded.trim() as LogLevel;
  const { color, dim } = createTheme(mode);
  const token = LEVEL_TOKEN[level];
  const body = rest.replace(
    FIELD_KEY,
    (_, key: string) => ` ${dim(`${key}=`)}`,
  );
  const message =
    level === "error" || level === "warn"
      ? color(token, body)
      : level === "debug" || level === "trace"
        ? dim(body)
        : body;
  return `${dim(time)} ${color(token, padded)} ${message}`;
}

/** How much of a text a debug line shows; a trace line shows it all. */
export const PREVIEW_LIMIT = 200;

/**
 * Text on one line for the log: whitespace runs collapse to one space, and
 * below `trace` it is cut to `PREVIEW_LIMIT` characters.
 * @param text - The text (a prompt, a thought, a reply).
 * @param level - The log's threshold; `trace` keeps everything.
 * @returns The one-line preview.
 */
export function preview(text: string, level: LogLevel): string {
  const line = text.replace(/\s+/g, " ").trim();
  return level !== "trace" && line.length > PREVIEW_LIMIT
    ? `${line.slice(0, PREVIEW_LIMIT - 1)}…`
    : line;
}

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
   * @param paint - Whether echoed lines are colored; by default when stderr
   *   is a terminal or color is forced (`paintLogLine` still honours
   *   `--no-color` and `NO_COLOR`).
   */
  constructor(
    readonly file: string | null,
    public level: LogLevel,
    private readonly echo: boolean,
    private readonly paint: boolean = Boolean(process.stderr.isTTY) ||
      process.argv.includes("--force-color") ||
      isTruthyEnv(process.env.FORCE_COLOR),
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
    if (this.echo)
      process.stderr.write(
        this.paint ? `${paintLogLine(line.slice(0, -1))}\n` : line,
      );
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

  /**
   * @param message - The message.
   * @param fields - Fields.
   */
  trace(message: string, fields?: LogFields): void {
    this.write("trace", message, fields);
  }
}
