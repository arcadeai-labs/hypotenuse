import { describe, expect, test } from "bun:test";
import tokens from "../../../design/tokens.json";
import { applyEarlyEnv } from "../../src/output/early-env";
import {
  createTheme,
  GLYPHS,
  nearestXterm256,
  THEME_TOKENS,
  truncateMiddle,
} from "../../src/output/theme";
import {
  detectColorDepth,
  detectMode,
  type OutputMode,
} from "../../src/output/tty";

const TTY = { isTTY: true };

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

describe("color depth", () => {
  test("truecolor when COLORTERM says so", () => {
    expect(detectColorDepth({ ...TTY, env: { COLORTERM: "truecolor" } })).toBe(
      "truecolor",
    );
    expect(detectColorDepth({ ...TTY, env: { COLORTERM: "24bit" } })).toBe(
      "truecolor",
    );
  });

  test("256 on a TTY without COLORTERM", () => {
    expect(detectColorDepth({ ...TTY, env: { TERM: "xterm-256color" } })).toBe(
      "256",
    );
  });

  test("none when piped, under NO_COLOR, --no-color, or --json", () => {
    const env = { COLORTERM: "truecolor" };
    expect(detectColorDepth({ isTTY: false, env })).toBe("none");
    expect(detectColorDepth({ ...TTY, env: { ...env, NO_COLOR: "1" } })).toBe(
      "none",
    );
    expect(detectColorDepth({ ...TTY, env, argv: ["--no-color"] })).toBe(
      "none",
    );
    expect(detectColorDepth({ ...TTY, env, argv: ["--json"] })).toBe("none");
  });

  test("FORCE_COLOR colors a pipe; FORCE_COLOR=0 does not", () => {
    expect(detectColorDepth({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(
      "256",
    );
    expect(detectColorDepth({ isTTY: false, env: { FORCE_COLOR: "0" } })).toBe(
      "none",
    );
  });

  test("--no-color and --json beat an inherited FORCE_COLOR", () => {
    const env = { FORCE_COLOR: "1" };
    expect(detectColorDepth({ ...TTY, env, argv: ["--no-color"] })).toBe(
      "none",
    );
    expect(detectColorDepth({ ...TTY, env, argv: ["--json"] })).toBe("none");
    expect(applyEarlyEnv(["--no-color"], { FORCE_COLOR: "1" })).toEqual({
      NO_COLOR: "1",
    });
  });

  test("early env turns flags into the variables detection reads", () => {
    expect(applyEarlyEnv(["--json"], {}).NO_COLOR).toBe("1");
    expect(applyEarlyEnv(["--no-color"], { NO_COLOR: "yes" }).NO_COLOR).toBe(
      "yes",
    );
    const forced = applyEarlyEnv(["--force-color"], { NO_COLOR: "1" });
    expect(forced).toEqual({ FORCE_COLOR: "1" });
    expect(applyEarlyEnv(["--force-color", "--json"], {})).toEqual({
      NO_COLOR: "1",
    });
  });

  test("CI and --json are not interactive", () => {
    expect(detectMode({ ...TTY, env: { CI: "true" } }).interactive).toBe(false);
    expect(detectMode({ ...TTY, env: {}, argv: ["--json"] }).json).toBe(true);
  });
});

describe("palette", () => {
  test("every token the CLI names exists in both generated themes", () => {
    const names = new Set([
      ...THEME_TOKENS,
      ...Object.values(GLYPHS).map((g) => g.token),
    ]);
    for (const theme of [tokens.light, tokens.dark]) {
      const have = Object.keys(theme);
      expect([...names].filter((n) => !have.includes(n))).toEqual([]);
    }
  });

  test("truecolor emits the token's exact channels; dark by default", () => {
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(tokens.dark.accent.slice(i, i + 2), 16),
    );
    expect(createTheme(mode({ depth: "truecolor" })).color("accent", "x")).toBe(
      `\x1b[38;2;${r};${g};${b}mx\x1b[0m`,
    );
  });

  test("COLORFGBG with a light background selects the light values", () => {
    expect(detectMode({ ...TTY, env: { COLORFGBG: "0;15" } })).toMatchObject({
      lightBackground: true,
    });
    expect(detectMode({ ...TTY, env: { COLORFGBG: "15;0" } })).toMatchObject({
      lightBackground: false,
    });
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
  test("Unicode under a UTF-8 locale, ASCII under LANG=C", () => {
    const utf8 = detectMode({ ...TTY, env: { LANG: "en_US.UTF-8" } });
    const c = detectMode({ ...TTY, env: { LANG: "C" } });
    expect(utf8.unicode).toBe(true);
    expect(c.unicode).toBe(false);
    const ascii = createTheme({ ...c, depth: "none" });
    expect(
      ["pending", "active", "awaitingInput", "complete", "error"].map((n) =>
        ascii.glyph(n as keyof typeof GLYPHS),
      ),
    ).toEqual(["o", "*", "?", "v", "x"]);
    expect(createTheme(mode()).glyph("active")).toBe("◔");
  });

  test("LC_ALL beats LANG", () => {
    expect(
      detectMode({ ...TTY, env: { LANG: "C", LC_ALL: "C.UTF-8" } }),
    ).toMatchObject({ unicode: true });
  });

  test("every glyph's ASCII fallback is ASCII", () => {
    for (const g of Object.values(GLYPHS)) {
      expect(g.ascii).toMatch(/^[\x20-\x7e]$/);
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
        { id: "ENG-142", slots: 2 },
        { id: "ENG-9", slots: 12 },
      ],
      [{ key: "id" }, { key: "slots" }],
    );
    expect(out.split("\n")).toEqual([
      "ID       SLOTS",
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
