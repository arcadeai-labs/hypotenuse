import { describe, expect, test } from "bun:test";
import { SKELETON_WIDTHS, skeletonWidth } from "../utils/skeleton";

// `utils/skeleton.ts` is deliberately pure — no JSX, no DOM — for the reason
// `utils/transcript.ts` is: what goes quietly wrong in it is arithmetic, and
// arithmetic does not need a browser. There is no component-render setup in this
// suite and this test does not invent one; everything about the rendered element
// is asserted in `e2e/theme.spec.ts`.

describe("skeleton bar widths", () => {
  test("no column repeats itself down the page, at any table width", () => {
    // The bug this exists for. The obvious `row * columns + column` gives every
    // column one width all the way down whenever the column count divides the
    // cycle length — seven perfectly straight stripes on a seven-column table —
    // and it looks completely deliberate. Three, five, and seven are pairwise
    // coprime, which is what makes this hold for every width rather than for the
    // six-column table somebody happened to look at.
    for (let columns = 1; columns <= 12; columns++) {
      for (let column = 0; column < columns; column++) {
        const down = Array.from({ length: SKELETON_WIDTHS.length }, (_, row) =>
          skeletonWidth(row, column),
        );
        expect(new Set(down).size).toBe(SKELETON_WIDTHS.length);
      }
    }
  });

  test("a row is ragged across, not a straight edge", () => {
    const across = Array.from({ length: 6 }, (_, column) =>
      skeletonWidth(0, column),
    );
    expect(new Set(across).size).toBeGreaterThan(1);
  });

  test("the same cell is always the same width", () => {
    // The anti-`Math.random()` guarantee, and it is not cosmetic: both run pages
    // refresh from the socket, so a skeleton that reshuffled on every re-render
    // would flicker for as long as it was on screen, and no screenshot of one
    // would be reproducible.
    expect(skeletonWidth(2, 3)).toBe(skeletonWidth(2, 3));
  });

  test("every width is a `ch` length", () => {
    // `ch` because there is one typeface everywhere, so a character count is an
    // exact measurement — the same reason `.tx-log`'s gutter is `9ch`.
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        expect(skeletonWidth(row, column)).toMatch(/^\d+ch$/);
      }
    }
  });
});
