import { describe, expect, test } from "bun:test";
import { detectColorDepth, detectMode } from "../../src/output/tty";

const TTY = { isTTY: true };

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
    expect(detectColorDepth({ ...TTY, env, argv: ["-j"] })).toBe("none");
  });

  test("FORCE_COLOR or --force-color colors a pipe; FORCE_COLOR=0 does not", () => {
    expect(detectColorDepth({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(
      "256",
    );
    expect(
      detectColorDepth({ isTTY: false, env: {}, argv: ["--force-color"] }),
    ).toBe("256");
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
  });

  test("CI and --json are not interactive", () => {
    expect(detectMode({ ...TTY, env: { CI: "true" } }).interactive).toBe(false);
    expect(detectMode({ ...TTY, env: {} }).interactive).toBe(true);
    expect(detectMode({ ...TTY, env: {}, argv: ["--json"] })).toMatchObject({
      json: true,
      interactive: false,
    });
  });
});

describe("terminal background and locale", () => {
  test("COLORFGBG with a light background selects the light values", () => {
    expect(detectMode({ ...TTY, env: { COLORFGBG: "0;15" } })).toMatchObject({
      lightBackground: true,
    });
    expect(detectMode({ ...TTY, env: { COLORFGBG: "0;7" } })).toMatchObject({
      lightBackground: true,
    });
    expect(detectMode({ ...TTY, env: { COLORFGBG: "15;0" } })).toMatchObject({
      lightBackground: false,
    });
    expect(detectMode({ ...TTY, env: {} })).toMatchObject({
      lightBackground: false,
    });
  });

  test("Unicode under a UTF-8 locale or none at all, ASCII under LANG=C", () => {
    expect(detectMode({ ...TTY, env: { LANG: "en_US.UTF-8" } }).unicode).toBe(
      true,
    );
    expect(detectMode({ ...TTY, env: {} }).unicode).toBe(true);
    expect(detectMode({ ...TTY, env: { LANG: "C" } }).unicode).toBe(false);
  });

  test("LC_ALL beats LANG", () => {
    expect(
      detectMode({ ...TTY, env: { LANG: "C", LC_ALL: "C.UTF-8" } }),
    ).toMatchObject({ unicode: true });
    expect(
      detectMode({ ...TTY, env: { LANG: "en_US.UTF-8", LC_ALL: "C" } }),
    ).toMatchObject({ unicode: false });
  });
});
