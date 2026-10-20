import { describe, expect, test } from "bun:test";
import { CONTRAST_PAIRS, contrastRatio, generateAll } from "../../../design/tokens";

// WCAG 2.1 contrast for every foreground/background pair the components draw,
// in both themes: 4.5:1 for text, 3:1 for glyphs and focus rings. The pairs are
// declared next to the generator, so a new token that is drawn on a surface is
// one line there and is checked here without touching this file.

const themes = generateAll();

describe("contrast", () => {
  for (const mode of ["light", "dark"] as const) {
    test(`every declared pair clears its minimum in ${mode}`, () => {
      const failures = CONTRAST_PAIRS.flatMap(({ fg, bg, min }) => {
        const ratio = contrastRatio(themes[mode][fg]!, themes[mode][bg]!);
        return ratio >= min ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`];
      });
      expect(failures).toEqual([]);
    });
  }

  test("every pair names tokens that exist", () => {
    for (const { fg, bg } of CONTRAST_PAIRS) {
      expect(themes.light[fg]).toBeDefined();
      expect(themes.light[bg]).toBeDefined();
    }
  });

  test("the ratio itself matches WCAG's reference extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
