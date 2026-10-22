import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  APP_ICON_SIZE,
  generateAll,
  lchToSrgb8,
  OUTPUTS,
  renderAppIcon,
  toHex,
} from "../../../design/tokens";

// The theme is written once, as inputs, and generated into every file that
// needs it. A hand edit to a generated file — the easiest way to "just tweak a
// color" — fails here, because the committed bytes no longer match a fresh run.

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("design tokens", () => {
  test("every generated file equals a fresh generation", () => {
    const themes = generateAll();
    for (const { path, render } of OUTPUTS) {
      const next = render(themes);
      // Text compares as text so a failure shows a readable diff; ICO and PNG as bytes.
      const body =
        typeof next === "string"
          ? readFileSync(join(ROOT, path), "utf8")
          : readFileSync(join(ROOT, path));
      expect({ path, body }).toEqual({ path, body: next });
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
    for (const [[l, c, h], hex] of cases)
      expect(toHex(lchToSrgb8({ l, c, h }))).toBe(hex);
  });

  test("generation is deterministic and both themes declare the same token set", () => {
    const a = generateAll();
    expect(generateAll()).toEqual(a);
    expect(Object.keys(a.dark).sort()).toEqual(Object.keys(a.light).sort());
    for (const value of [...Object.values(a.light), ...Object.values(a.dark)]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("the app icon is an opaque square whose mark survives a circular crop", () => {
    const themes = generateAll();
    const png = renderAppIcon(themes);
    expect(png.readUInt32BE(16)).toBe(APP_ICON_SIZE);
    expect(png.readUInt32BE(20)).toBe(APP_ICON_SIZE);
    // One IDAT, written unfiltered by encodePng: a filter byte, then RGBA rows.
    const idat = png.indexOf("IDAT", 0, "latin1");
    const raw = inflateSync(
      png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)),
    );
    const ground = themes.light["bg-panel"]!;
    const half = APP_ICON_SIZE / 2;
    for (let y = 0; y < APP_ICON_SIZE; y++) {
      for (let x = 0; x < APP_ICON_SIZE; x++) {
        const o = y * (APP_ICON_SIZE * 4 + 1) + 1 + x * 4;
        expect(raw[o + 3]).toBe(255);
        if (Math.hypot(x + 0.5 - half, y + 0.5 - half) <= half) continue;
        const hex = `#${[0, 1, 2].map((i) => raw[o + i]!.toString(16).padStart(2, "0")).join("")}`;
        if (hex !== ground)
          throw new Error(`mark outside the inscribed circle at ${x},${y}`);
      }
    }
  });
});
