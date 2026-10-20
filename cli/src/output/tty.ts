/**
 * The single place the CLI decides how its output may look: whether it is
 * interactive, how many colors the terminal takes, and whether glyphs may be
 * Unicode. Every decision is a pure function of an injected environment, so a
 * test states its terminal instead of patching `process`.
 *
 * Resolution, in order:
 *   --no-color / --json                  → no color, whatever the env says
 *   --force-color / FORCE_COLOR (truthy) → color on, even when piped
 *   NO_COLOR                             → no color
 *   neither stdout nor stderr is a TTY   → no color
 *   COLORTERM=truecolor|24bit            → 24-bit
 *   otherwise                            → nearest xterm-256 index
 */

/** How many colors the output may use. */
export type ColorDepth = "truecolor" | "256" | "none";

/** What the terminal looks like, as far as output is concerned. */
export interface Terminal {
  /** Environment variables (`process.env` in production). */
  env: Record<string, string | undefined>;
  /** Whether stdout and/or stderr are attached to a terminal. */
  isTTY: boolean;
  /** Arguments after the program name. */
  argv?: readonly string[];
}

/** The resolved output mode. */
export interface OutputMode {
  /** A person is watching: a TTY, not `--json`, and not CI. */
  interactive: boolean;
  /** Color depth to render with. */
  depth: ColorDepth;
  /** Machine-readable output was requested. */
  json: boolean;
  /** Glyphs may be Unicode rather than their ASCII fallbacks. */
  unicode: boolean;
  /** The terminal background is light, so the light token values apply. */
  lightBackground: boolean;
}

/**
 * Whether an environment value means "on". Empty, `0`, and `false` are off.
 * @param value - The raw value.
 * @returns True for any other non-empty string.
 */
export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower !== "0" && lower !== "false";
}

/**
 * Decide the color depth for a terminal.
 * @param term - The terminal to decide for.
 * @returns `truecolor`, `256`, or `none`.
 */
export function detectColorDepth(term: Terminal): ColorDepth {
  const { env } = term;
  const argv = term.argv ?? [];
  // A flag on this command line beats a variable inherited from the shell.
  const flagPlain =
    argv.includes("--no-color") ||
    argv.includes("--json") ||
    argv.includes("-j");
  if (flagPlain) return "none";
  const force = argv.includes("--force-color") || isTruthyEnv(env.FORCE_COLOR);
  if (!force && (Boolean(env.NO_COLOR) || !term.isTTY)) return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  return "256";
}

/**
 * Whether the locale can render Unicode glyphs. The first of `LC_ALL`,
 * `LC_CTYPE`, `LANG` that is set decides, as it does for the C library; with
 * none set, assume UTF-8, which every modern terminal is.
 * @param env - Environment variables.
 * @returns True when the effective locale names UTF-8.
 */
export function detectUnicode(
  env: Record<string, string | undefined>,
): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (!locale) return true;
  return /utf-?8/i.test(locale);
}

/**
 * Whether `COLORFGBG` says the background is light. Its last field is the
 * background's ANSI index; 7 (white) and 15 (bright white) are light.
 * @param env - Environment variables.
 * @returns True only when the terminal reports a light background.
 */
export function detectLightBackground(
  env: Record<string, string | undefined>,
): boolean {
  const bg = env.COLORFGBG?.split(";").at(-1);
  return bg === "7" || bg === "15";
}

/**
 * Resolve the whole output mode for a terminal.
 * @param term - The terminal to resolve for.
 * @returns The mode every output helper renders with.
 */
export function detectMode(term: Terminal): OutputMode {
  const argv = term.argv ?? [];
  const json = argv.includes("--json") || argv.includes("-j");
  return {
    interactive: term.isTTY && !json && !isTruthyEnv(term.env.CI),
    depth: detectColorDepth(term),
    json,
    unicode: detectUnicode(term.env),
    lightBackground: detectLightBackground(term.env),
  };
}

let current: OutputMode | null = null;

/**
 * The mode for this process, detected on first use from the real streams.
 * @returns The cached mode.
 */
export function getMode(): OutputMode {
  current ??= detectMode({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY || process.stderr.isTTY),
    argv: process.argv.slice(2),
  });
  return current;
}

/**
 * Replace the process mode (tests, or after commander parses a flag).
 * @param mode - The mode to use, or `null` to re-detect on next use.
 */
export function setMode(mode: OutputMode | null): void {
  current = mode;
}
