import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "./sourceScan";

// Both faces are self-hosted. A font CDN is a third-party request on every page
// load and a privacy leak; CI also scans the built `dist/` for the same hosts.

const FONT_CDNS = /fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|rsms\.me/;

describe("fonts", () => {
  test("no source file or index.html references a font CDN", () => {
    const files = [
      ...sourceFiles([".scss", ".css", ".tsx", ".ts"]),
      { path: "index.html", body: readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8") },
    ];
    expect(files.filter(({ body }) => FONT_CDNS.test(body)).map((f) => f.path)).toEqual([]);
  });

  test("main.tsx imports both self-hosted faces", () => {
    const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");
    expect(main).toContain("@fontsource-variable/inter");
    expect(main).toContain("@fontsource-variable/jetbrains-mono");
  });
});
