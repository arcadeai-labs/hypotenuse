import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateAll, lchToSrgb8, OUTPUTS, toHex } from "../../../design/tokens";

// The theme is written once, as inputs, and generated into every file that
// needs it. A hand edit to a generated file — the easiest way to "just tweak a
// color" — fails here, because the committed bytes no longer match a fresh run.

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("design tokens", () => {
  test("every generated file equals a fresh generation", () => {
    const themes = generateAll();
    for (const { path, render } of OUTPUTS) {
      expect({ path, body: readFileSync(join(ROOT, path), "utf8") }).toEqual({ path, body: render(themes) });
    }
  });

  test("LCH → sRGB matches CSS Color 4 reference values", () => {
    const cases: Array<[[number, number, number], string]> = [
      [[0, 0, 0], "#000000"],
      [[100, 0, 0], "#ffffff"],
      [[50, 0, 0], "#777777"],
      [[54.29, 106.84, 40.85], "#ff0000"],
      [[87.82, 113.33, 134.38], "#00ff00"],
      [[29.57, 131.2, 301.36], "#0000ff"],
    ];
    for (const [[l, c, h], hex] of cases) expect(toHex(lchToSrgb8({ l, c, h }))).toBe(hex);
  });

  test("generation is deterministic and both themes declare the same token set", () => {
    const a = generateAll();
    expect(generateAll()).toEqual(a);
    expect(Object.keys(a.dark).sort()).toEqual(Object.keys(a.light).sort());
    for (const value of [...Object.values(a.light), ...Object.values(a.dark)]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
