import { describe, expect, test } from "bun:test";
import { sourceFiles, stripComments } from "./sourceScan";

// A custom property defined as itself (`--font-sans: var(--font-sans)`) is a
// cycle, and a cycle computes to nothing — every page silently fell back to the
// browser's serif face before this existed. Tailwind's `@theme` is where it
// happens, because its namespaces share names with our tokens.

describe("custom properties", () => {
  test("no custom property is defined in terms of itself", () => {
    const offenders = sourceFiles([".scss", ".css"]).flatMap(({ path, body }) =>
      [...stripComments(body).matchAll(/(--[\w-]+)\s*:\s*var\(\s*(--[\w-]+)/g)]
        .filter(([, name, ref]) => name === ref)
        .map(([decl]) => `${path}: ${decl}`),
    );
    expect(offenders).toEqual([]);
  });
});
