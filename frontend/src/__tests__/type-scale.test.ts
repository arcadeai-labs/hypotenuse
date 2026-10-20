import { describe, expect, test } from "bun:test";
import { sourceFiles, stripComments } from "./sourceScan";

// Every font size is a ratio of `--font-size`. A literal `rem`/`px` size does
// not look stale when the base changes — it looks like a deliberately tiny
// footer — so the base lives in exactly one declaration and everything else is
// `calc(var(--font-size) * n)` or a `--text-*` step built from it.

describe("type scale", () => {
  test("no literal font sizes outside the --font-size declaration", () => {
    const offenders = sourceFiles([".scss", ".css"]).flatMap(({ path, body }) =>
      stripComments(body)
        .split("\n")
        .filter((line) =>
          /(?<![-\w])font-size\s*:\s*[0-9.]+(?:rem|px|em|pt)\b/.test(line),
        )
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the base size is declared exactly once", () => {
    const declarations = sourceFiles([".scss", ".css"]).flatMap(
      ({ path, body }) =>
        (stripComments(body).match(/--font-size\s*:/g) ?? []).map(() => path),
    );
    expect(declarations).toEqual(["styles/_type.scss"]);
  });

  test("inline styles in components set no font size", () => {
    const offenders = sourceFiles([".tsx"]).filter(({ body }) =>
      /fontSize\s*:/.test(body),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
