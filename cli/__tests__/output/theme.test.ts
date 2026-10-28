import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_STATUS_ORDER,
  type ConversationStatus,
  GLYPH_KINDS,
  type GlyphKind,
  SANDBOX_JOB_STATES,
  type SandboxJobState,
} from "../../../design/states";
import tokens from "../../../design/tokens.json" with { type: "json" };
import {
  createTheme,
  nearestXterm256,
  THEME_TOKENS,
  truncateMiddle,
} from "../../src/output/theme";
import type { OutputMode } from "../../src/output/tty";

const KINDS = Object.keys(GLYPH_KINDS) as GlyphKind[];

/**
 * A mode with sensible defaults for rendering tests.
 * @param over - Fields to override.
 * @returns The mode.
 */
function mode(over: Partial<OutputMode> = {}): OutputMode {
  return {
    interactive: true,
    depth: "none",
    json: false,
    unicode: true,
    lightBackground: false,
    ...over,
  };
}

/**
 * The truecolor SGR sequence for a hex color, as the theme writes it.
 * @param hex - `#rrggbb`.
 * @param text - The painted text.
 * @returns The escaped string.
 */
function truecolor(hex: string, text: string): string {
  const [r, g, b] = [1, 3, 5].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16),
  );
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

describe("palette", () => {
  test("every token the CLI names exists in both generated themes", () => {
    const names = new Set<string>([
      ...THEME_TOKENS,
      ...Object.values(GLYPH_KINDS).map((g) => g.token),
    ]);
    expect(names.has("status-idle")).toBe(true);
    for (const theme of [tokens.light, tokens.dark]) {
      const have = Object.keys(theme);
      expect([...names].filter((n) => !have.includes(n))).toEqual([]);
    }
  });

  test("every glyph's token is one the CLI lists", () => {
    const listed = new Set<string>(THEME_TOKENS);
    const unlisted = Object.values(GLYPH_KINDS)
      .map((g) => g.token)
      .filter((t) => !listed.has(t));
    expect(unlisted).toEqual([]);
  });

  test("truecolor emits the token's exact channels; dark by default", () => {
    expect(createTheme(mode({ depth: "truecolor" })).color("accent", "x")).toBe(
      truecolor(tokens.dark.accent, "x"),
    );
  });

  test("a light background selects the light values", () => {
    const light = createTheme(mode({ depth: "256", lightBackground: true }));
    expect(light.color("accent", "x")).toBe(
      `\x1b[38;5;${nearestXterm256(tokens.light.accent)}mx\x1b[0m`,
    );
  });

  test("256 maps to the cube and the gray ramp", () => {
    expect(nearestXterm256("#ff0000")).toBe(196);
    expect(nearestXterm256("#000000")).toBe(16);
    expect(nearestXterm256("#808080")).toBe(244);
  });

  test("no color returns text untouched", () => {
    expect(createTheme(mode()).color("accent", "plain")).toBe("plain");
  });
});

describe("glyphs", () => {
  test("every kind renders its Unicode shape under UTF-8", () => {
    const theme = createTheme(mode());
    for (const kind of KINDS) {
      expect(theme.glyph(kind), kind).toBe(GLYPH_KINDS[kind].unicode);
    }
  });

  test("every kind renders its ASCII fallback when the locale is not UTF-8", () => {
    const theme = createTheme(mode({ unicode: false }));
    for (const kind of KINDS) {
      expect(theme.glyph(kind), kind).toBe(GLYPH_KINDS[kind].ascii);
    }
  });

  test("ASCII fallbacks are single printable characters, one per kind", () => {
    const ascii = KINDS.map((k) => GLYPH_KINDS[k].ascii);
    for (const a of ascii) expect(a).toMatch(/^[\x21-\x7e]$/);
    expect(new Set(ascii).size).toBe(ascii.length);
  });

  test("a glyph is painted with its kind's token", () => {
    const theme = createTheme(mode({ depth: "truecolor" }));
    for (const kind of KINDS) {
      const { token, unicode } = GLYPH_KINDS[kind];
      expect(theme.glyph(kind), kind).toBe(
        truecolor(tokens.dark[token], unicode),
      );
    }
    expect(theme.glyph("hibernating")).toBe(
      truecolor(tokens.dark["status-idle"], "○"),
    );
  });

  test("every conversation status maps to the glyph the web shows", () => {
    const theme = createTheme(mode());
    const statuses: [ConversationStatus, string][] = [
      [{ state: "working" }, "◔"],
      [{ state: "hibernating" }, "○"],
      [{ state: "waiting", waitingOn: "answer" }, "◉"],
      [{ state: "waiting", waitingOn: "approval" }, "◉"],
      [{ state: "waiting", waitingOn: "sandbox" }, "◷"],
      [{ state: "waiting", waitingOn: "timer" }, "◷"],
      [{ state: "ended", outcome: "complete" }, "✓"],
      [{ state: "ended", outcome: "failed" }, "✕"],
    ];
    // The literal list above covers every status the shared table knows.
    expect(statuses.length).toBe(CONVERSATION_STATUS_ORDER.length);
    for (const [status, shape] of statuses) {
      expect(theme.conversationGlyph(status), JSON.stringify(status)).toBe(
        shape,
      );
    }
    expect(
      createTheme(mode({ unicode: false })).conversationGlyph({
        state: "waiting",
        waitingOn: "approval",
      }),
    ).toBe("?");
  });

  test("every sandbox job state maps to the glyph the web shows", () => {
    const theme = createTheme(mode());
    const states: Record<SandboxJobState, string> = {
      provisioning: "◌",
      running: "◔",
      complete: "✓",
      failed: "✕",
    };
    expect(Object.keys(states).sort()).toEqual([...SANDBOX_JOB_STATES].sort());
    for (const state of SANDBOX_JOB_STATES) {
      expect(theme.sandboxJobGlyph(state), state).toBe(states[state]);
    }
  });
});

describe("table", () => {
  test("truncates in the middle, keeping both ends", () => {
    expect(truncateMiddle("hypotenuse/eng-142-add-retry", 15)).toBe(
      "hypoten…d-retry",
    );
    expect(truncateMiddle("hypotenuse/eng-142-add-retry", 15)).toHaveLength(15);
    expect(truncateMiddle("short", 15)).toBe("short");
  });

  test("right-aligns numeric columns, left-aligns the rest, no borders", () => {
    const out = createTheme(mode()).table(
      [
        { id: "ENG-142", turns: 2 },
        { id: "ENG-9", turns: 12 },
      ],
      [{ key: "id" }, { key: "turns" }],
    );
    expect(out.split("\n")).toEqual([
      "ID       TURNS",
      "ENG-142      2",
      "ENG-9       12",
    ]);
  });

  test("headers are dim when color is on; ASCII ellipsis without UTF-8", () => {
    const t = createTheme(mode({ depth: "256", unicode: false }));
    const out = t.table([{ b: "abcdefghij" }], [{ key: "b", maxWidth: 7 }]);
    expect(out.split("\n")[0]).toStartWith("\x1b[2m");
    expect(out).toContain("ab...ij");
  });
});

describe("banner", () => {
  test("is the mark plus the version on one line", () => {
    expect(createTheme(mode()).banner("1.4.0")).toBe("◢ hypotenuse 1.4.0");
    expect(createTheme(mode({ unicode: false })).banner("1.4.0")).toBe(
      "hypotenuse 1.4.0",
    );
  });
});
