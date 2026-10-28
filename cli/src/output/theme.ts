/**
 * The terminal half of the design system. Colors come from `design/tokens.json`
 * — the same generated values the web app and the OAuth page use — embedded at
 * build time by the JSON import, so a compiled binary carries them. Glyphs come
 * from `design/states.ts`, the table the web's `StatusGlyph` reads too, so a
 * renamed state or glyph is a type error here and there alike. Each glyph has an
 * ASCII fallback for a locale that cannot draw it.
 *
 * `createTheme(mode)` is the pure core; `color`, `glyph`, `table`, and `banner`
 * are the same functions bound to this process's detected mode.
 */
import {
  CONVERSATION_STATUS,
  type ConversationStatus,
  conversationStatusKey,
  GLYPH_KINDS,
  type GlyphKind,
  SANDBOX_JOB_STATUS,
  type SandboxJobState,
} from "../../../design/states";
import tokens from "../../../design/tokens.json" with { type: "json" };
import { getMode, type OutputMode } from "./tty";

/** The token a status glyph is painted with, straight from the shared state table. */
export type GlyphToken = (typeof GLYPH_KINDS)[GlyphKind]["token"];

/** A semantic color token the CLI renders with. */
export type Token =
  | "text-primary"
  | "text-secondary"
  | "text-tertiary"
  | "accent"
  | GlyphToken
  | "diff-add"
  | "diff-remove";

/** Every token this module may name; the test checks each exists in both themes. */
export const THEME_TOKENS: readonly Token[] = [
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "accent",
  "status-pending",
  "status-active",
  "status-waiting",
  "status-complete",
  "status-error",
  "status-idle",
  "status-stale",
  "diff-add",
  "diff-remove",
];

/** One column of a `table`. */
export interface Column<Row> {
  /** Which field of the row to show. */
  key: keyof Row & string;
  /** Header text, rendered dim. Defaults to the key upper-cased. */
  header?: string;
  /** Alignment; defaults to `right` when every value is numeric. */
  align?: "left" | "right";
  /** Truncate longer values in the middle to this many characters. */
  maxWidth?: number;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Parse `#rrggbb` into channels.
 * @param hex - The color.
 * @returns `[r, g, b]`, each 0–255.
 */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The xterm-256 palette index nearest an sRGB color, searching the 6×6×6 cube
 * and the 24-step gray ramp (the 16 system colors vary by terminal, so never).
 * @param hex - `#rrggbb`.
 * @returns An index from 16 to 255.
 */
export function nearestXterm256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const steps = [0, 95, 135, 175, 215, 255];
  const nearestStep = (v: number) =>
    steps.reduce(
      (best, s, i) =>
        Math.abs(s - v) < Math.abs((steps[best] ?? 0) - v) ? i : best,
      0,
    );
  const [ri, gi, bi] = [nearestStep(r), nearestStep(g), nearestStep(b)];
  const cube: [number, number, number] = [
    steps[ri] ?? 0,
    steps[gi] ?? 0,
    steps[bi] ?? 0,
  ];
  const grayIndex = Math.max(
    0,
    Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)),
  );
  const gray = 8 + grayIndex * 10;
  const dist = (c: [number, number, number]) =>
    (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return dist(cube) <= dist([gray, gray, gray])
    ? 16 + 36 * ri + 6 * gi + bi
    : 232 + grayIndex;
}

/**
 * Visible width of a string: ANSI escapes stripped, one column per code point.
 * @param text - Possibly colored text.
 * @returns Its width in columns.
 */
export function visibleWidth(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

/**
 * Shorten a string by removing its middle, keeping both ends — a path or branch
 * name is identified by its start and its end.
 * @param text - The value.
 * @param width - Maximum width.
 * @param ellipsis - The marker for the removed middle.
 * @returns `text` if it fits, else start + ellipsis + end at exactly `width`.
 */
export function truncateMiddle(
  text: string,
  width: number,
  ellipsis = "…",
): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  const mark = [...ellipsis].length;
  if (width <= mark) return chars.slice(0, width).join("");
  const keep = width - mark;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return (
    chars.slice(0, head).join("") +
    ellipsis +
    (tail > 0 ? chars.slice(-tail).join("") : "")
  );
}

/**
 * Build the output helpers for one mode. Pure: the same mode gives the same strings.
 * @param mode - The resolved output mode.
 * @returns `color`, `dim`, `glyph`, `conversationGlyph`, `sandboxJobGlyph`,
 *   `table`, and `banner` bound to that mode.
 */
export function createTheme(mode: OutputMode) {
  // Typed by the tokens the CLI names, so a token missing from either
  // generated theme fails to compile, not just the test.
  const palette: Record<Token, string> = mode.lightBackground
    ? tokens.light
    : tokens.dark;

  /**
   * Paint text in a token's color, or return it unchanged without color.
   * @param token - The semantic token.
   * @param text - The text.
   * @returns The text, possibly wrapped in an SGR sequence.
   */
  const color = (token: Token, text: string): string => {
    if (mode.depth === "none") return text;
    const hex = palette[token];
    if (!hex) return text;
    if (mode.depth === "truecolor") {
      const [r, g, b] = rgb(hex);
      return `${ESC}38;2;${r};${g};${b}m${text}${RESET}`;
    }
    return `${ESC}38;5;${nearestXterm256(hex)}m${text}${RESET}`;
  };

  /**
   * Render text faint, for headers and secondary detail.
   * @param text - The text.
   * @returns The text, possibly wrapped in the SGR dim sequence.
   */
  const dim = (text: string): string =>
    mode.depth === "none" ? text : `${ESC}2m${text}${RESET}`;

  /**
   * One glyph kind, colored by its token.
   * @param kind - The shape, from the shared state table.
   * @returns One colored character (ASCII when the locale is not UTF-8).
   */
  const glyph = (kind: GlyphKind): string => {
    const g = GLYPH_KINDS[kind];
    return color(g.token, mode.unicode ? g.unicode : g.ascii);
  };

  /**
   * The glyph for a conversation's status.
   * @param status - The state, with `waitingOn` or `outcome` where it has one.
   * @returns The colored glyph the web shows for the same status.
   */
  const conversationGlyph = (status: ConversationStatus): string =>
    glyph(CONVERSATION_STATUS[conversationStatusKey(status)].glyph);

  /**
   * The glyph for a sandbox job's state.
   * @param state - Where the job is in its life.
   * @returns The colored glyph the web shows for the same state.
   */
  const sandboxJobGlyph = (state: SandboxJobState): string =>
    glyph(SANDBOX_JOB_STATUS[state].glyph);

  /**
   * A borderless table: dim headers, two-space gutters, numbers right-aligned,
   * long values truncated in the middle.
   * @param rows - One object per row.
   * @param columns - Which fields to show, in order.
   * @returns The rendered lines joined by newlines, with no trailing whitespace.
   */
  const table = <Row extends Record<string, unknown>>(
    rows: readonly Row[],
    columns: readonly Column<Row>[],
  ): string => {
    const ellipsis = mode.unicode ? "…" : "...";
    const cells = rows.map((row) =>
      columns.map((col) => {
        const raw = row[col.key];
        const text = raw === undefined || raw === null ? "" : String(raw);
        return col.maxWidth
          ? truncateMiddle(text, col.maxWidth, ellipsis)
          : text;
      }),
    );
    const headers = columns.map((col) => col.header ?? col.key.toUpperCase());
    const align = columns.map((col, i) => {
      if (col.align) return col.align;
      const numeric =
        rows.length > 0 &&
        cells.every((r) => /^-?\d+(\.\d+)?%?$/.test(r[i] ?? ""));
      return numeric ? "right" : "left";
    });
    const widths = columns.map((_, i) =>
      Math.max(
        visibleWidth(headers[i] ?? ""),
        ...cells.map((r) => visibleWidth(r[i] ?? "")),
      ),
    );
    const pad = (text: string, i: number) => {
      const gap = " ".repeat((widths[i] ?? 0) - visibleWidth(text));
      return align[i] === "right" ? gap + text : text + gap;
    };
    const line = (values: string[], paint = (s: string) => s) =>
      values
        .map((v, i) => paint(pad(v, i)))
        .join("  ")
        .trimEnd();
    return [line(headers, dim), ...cells.map((r) => line(r))].join("\n");
  };

  /**
   * The one-line banner: the mark and the version.
   * @param version - The CLI version.
   * @returns `◢ hypotenuse <version>` (no mark when the locale is not UTF-8).
   */
  const banner = (version: string): string => {
    const name = `hypotenuse ${dim(version)}`;
    return mode.unicode ? `${color("accent", "◢")} ${name}` : name;
  };

  return {
    color,
    dim,
    glyph,
    conversationGlyph,
    sandboxJobGlyph,
    table,
    banner,
  };
}

/**
 * Paint text in a token's color for this process's terminal.
 * @param token - The semantic token.
 * @param text - The text.
 * @returns The possibly colored text.
 */
export function color(token: Token, text: string): string {
  return createTheme(getMode()).color(token, text);
}

/**
 * Render text faint for this process's terminal.
 * @param text - The text.
 * @returns The possibly dimmed text.
 */
export function dim(text: string): string {
  return createTheme(getMode()).dim(text);
}

/**
 * One glyph kind on this process's terminal.
 * @param kind - The shape, from the shared state table.
 * @returns The colored glyph or its ASCII fallback.
 */
export function glyph(kind: GlyphKind): string {
  return createTheme(getMode()).glyph(kind);
}

/**
 * The glyph for a conversation's status on this process's terminal.
 * @param status - The state, with `waitingOn` or `outcome` where it has one.
 * @returns The colored glyph or its ASCII fallback.
 */
export function conversationGlyph(status: ConversationStatus): string {
  return createTheme(getMode()).conversationGlyph(status);
}

/**
 * The glyph for a sandbox job's state on this process's terminal.
 * @param state - Where the job is in its life.
 * @returns The colored glyph or its ASCII fallback.
 */
export function sandboxJobGlyph(state: SandboxJobState): string {
  return createTheme(getMode()).sandboxJobGlyph(state);
}

/**
 * Render a borderless table for this process's terminal.
 * @param rows - One object per row.
 * @param columns - Which fields to show, in order.
 * @returns The rendered table.
 */
export function table<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  columns: readonly Column<Row>[],
): string {
  return createTheme(getMode()).table(rows, columns);
}

/**
 * The one-line banner for this process's terminal.
 * @param version - The CLI version.
 * @returns The banner line.
 */
export function banner(version: string): string {
  return createTheme(getMode()).banner(version);
}
