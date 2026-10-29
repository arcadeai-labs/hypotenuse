/**
 * The stderr logger, from mcpx. **stdout is data only**: a table, a JSON
 * object, a value a script captures. Everything addressed to a person goes to
 * stderr through here.
 *
 * - `info`, `success`, `warn` — hidden under `--json` and when stderr is not a
 *   terminal, so a pipeline sees nothing it did not ask for;
 * - `error` — always written;
 * - `debug` — only with `-v/--verbose`;
 * - `tell` — always written: instructions a person must see to finish what
 *   they started (the URL to open, the code to type), even when stderr is a
 *   pipe or a log file.
 */
import { createSpinner } from "nanospinner";
import { color, dim, glyph } from "./theme";
import { getMode } from "./tty";

/** A running spinner, or a no-op when none can be shown. */
export interface Spinner {
  update(text: string): void;
  success(text?: string): void;
  error(text?: string): void;
  stop(): void;
}

let verbose = false;
let activeSpinner: ReturnType<typeof createSpinner> | null = null;

/**
 * Whether person-facing chatter is suppressed.
 * @returns True under `--json` or when stderr is not a terminal.
 */
function quiet(): boolean {
  return getMode().json || !(process.stderr.isTTY ?? false);
}

/**
 * Write one line to stderr, around any active spinner.
 * @param line - The line, without its newline.
 */
function write(line: string): void {
  if (activeSpinner) {
    activeSpinner.clear();
    process.stderr.write(`${line}\n`);
    activeSpinner.render();
  } else {
    process.stderr.write(`${line}\n`);
  }
}

export const logger = {
  /**
   * Turn `debug` output on or off (from `-v/--verbose`).
   * @param on - Whether verbose output is wanted.
   */
  setVerbose(on: boolean): void {
    verbose = on;
  },

  /**
   * Secondary detail, faint.
   * @param msg - The message.
   */
  info(msg: string): void {
    if (!quiet()) write(dim(msg));
  },

  /**
   * Something finished well.
   * @param msg - The message.
   */
  success(msg: string): void {
    if (!quiet()) write(`${glyph("complete")} ${msg}`);
  },

  /**
   * Something the person should know but that did not fail.
   * @param msg - The message.
   */
  warn(msg: string): void {
    if (!quiet()) write(color("status-waiting", msg));
  },

  /**
   * A failure. Always written.
   * @param msg - The message.
   */
  error(msg: string): void {
    write(`${glyph("failed")} ${color("status-error", msg)}`);
  },

  /**
   * Instructions a person needs to finish the command. Always written.
   * @param msg - The message.
   */
  tell(msg: string): void {
    write(msg);
  },

  /**
   * Request-level detail for `--verbose`.
   * @param msg - The message.
   */
  debug(msg: string): void {
    if (verbose) write(dim(msg));
  },

  /**
   * Write raw text to stderr (the update notice), no newline added.
   * @param text - The text.
   */
  writeRaw(text: string): void {
    process.stderr.write(text);
  },

  /**
   * Start a spinner on stderr, or a no-op one when nobody is watching.
   * @param text - What is happening.
   * @returns The spinner.
   */
  spinner(text: string): Spinner {
    if (quiet() || !getMode().interactive) {
      return { update() {}, success() {}, error() {}, stop() {} };
    }
    const spinner = createSpinner(text, { stream: process.stderr }).start();
    activeSpinner = spinner;
    const done = () => {
      activeSpinner = null;
    };
    return {
      update: (t) => {
        spinner.update({ text: t });
      },
      success: (t) => {
        spinner.success({ text: t });
        done();
      },
      error: (t) => {
        spinner.error({ text: t });
        done();
      },
      stop: () => {
        spinner.stop();
        done();
      },
    };
  },
};
