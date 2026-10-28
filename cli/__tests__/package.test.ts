import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

describe("the published package", () => {
  test("is named for the command it installs", () => {
    expect(pkg.name).toBe("@arcadeai/hypotenuse");
    expect(Object.keys(pkg.bin)).toEqual(["hypotenuse"]);
  });

  test("names its repository exactly", () => {
    // Self-upgrade derives the GitHub repository whose releases it reads from
    // this URL, so a trailing slash or a missing `.git` breaks it.
    expect(pkg.repository.url).toBe(
      "https://github.com/arcadeai-labs/hypotenuse.git",
    );
  });
});

describe("the npm install", () => {
  test("the bin target is what prepack builds, and it ships", () => {
    // `npm install -g` links `bin.hypotenuse`; a path no script writes is an
    // install that succeeds and then has no command.
    const bundle = pkg.scripts.bundle.match(/--outfile (\S+)/)?.[1];
    expect(bundle).toBeDefined();
    expect(pkg.bin.hypotenuse).toBe(`./${bundle}`);
    expect(pkg.scripts.prepack).toBe("bun run bundle");
    expect(pkg.files).toContain(bundle!);
  });

  test("the bundle runs and prints the version", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "hypotenuse-bundle-"));
    try {
      const outfile = join(outDir, "hypotenuse.js");
      const cliDir = join(import.meta.dir, "..");
      const build = Bun.spawnSync(
        [
          "bun",
          "build",
          "./src/cli.ts",
          "--target",
          "bun",
          "--packages",
          "external",
          "--outfile",
          outfile,
        ],
        { cwd: cliDir },
      );
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync(["bun", outfile, "--version"], { cwd: cliDir });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe(pkg.version);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
