import { describe, expect, test } from "bun:test";
import { sourceFiles, stripComments } from "./sourceScan";

// Components consume semantic tokens only. A literal color anywhere in `src/`
// is a color that does not change with the theme and that the contrast test
// never sees — it reads fine in the theme its author was looking at.

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|lch|oklch|lab|oklab|hwb)\(/g;

describe("no raw colors", () => {
  test("no color literals in styles or components outside the generated tokens", () => {
    const offenders = sourceFiles([".scss", ".css", ".tsx", ".ts"]).flatMap(({ path, body }) =>
      (stripComments(body).match(LITERAL) ?? [])
        // `#` followed by hex digits is also how a URL fragment or an id selector can look.
        .filter((hit) => !/^#[0-9]+$/.test(hit))
        .map((hit) => `${path}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
