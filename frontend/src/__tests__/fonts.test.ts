import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "./sourceScan";

// Both faces are self-hosted. A font CDN is a third-party request on every page
// load and a privacy leak; CI also scans the built `dist/` for the same hosts.

const FONT_CDNS =
  /fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|rsms\.me/;

describe("fonts", () => {
  test("no source file or index.html references a font CDN", () => {
    const files = [
      ...sourceFiles([".scss", ".css", ".tsx", ".ts"]),
      {
        path: "index.html",
        body: readFileSync(
          join(import.meta.dir, "..", "..", "index.html"),
          "utf8",
        ),
      },
    ];
    expect(
      files.filter(({ body }) => FONT_CDNS.test(body)).map((f) => f.path),
    ).toEqual([]);
  });

  test("main.tsx imports both self-hosted faces", () => {
    const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");
    expect(main).toContain("@fontsource-variable/inter");
    expect(main).toContain("@fontsource-variable/jetbrains-mono");
  });

  test("code shows the characters typed: JetBrains Mono's ligatures are off", () => {
    // `=>` drawn as an arrow in a `run_code` program is not what the bot wrote.
    const type = readFileSync(
      join(import.meta.dir, "..", "styles", "_type.scss"),
      "utf8",
    );
    const rule = type.slice(type.indexOf("code,\nkbd,")).split("}")[0];
    expect(rule).toContain("font-family: var(--font-mono)");
    expect(rule).toContain("font-variant-ligatures: none");
  });
});
