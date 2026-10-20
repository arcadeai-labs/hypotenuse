import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const CLI_DIR = join(import.meta.dir, "..");

/** What `npm pack --dry-run --json` reports for one tarball. */
interface PackReport {
  files: { path: string }[];
}

let report: PackReport;

beforeAll(async () => {
  // Runs `prepack`, so this also proves the bundle builds.
  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
    cwd: CLI_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  // npm prints prepack's own output before the JSON array.
  report = (
    JSON.parse(stdout.slice(stdout.indexOf("\n[") + 1)) as PackReport[]
  )[0]!;
}, 60_000);

describe("the npm package", () => {
  test("ships the bundle, the skill, and the README — and no source", () => {
    const paths = report.files.map((f) => f.path).sort();
    expect(paths).toContain("dist/hypotenuse.js");
    expect(paths).toContain("skills/hypotenuse.md");
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths.filter((p) => p.startsWith("src/"))).toEqual([]);
    expect(paths.filter((p) => p.includes("__tests__"))).toEqual([]);
    // The compiled binary is a release asset, never part of the npm package.
    expect(paths).not.toContain("dist/hypotenuse");
  });

  test("bin points at the bundle, and package.json names no workspace package", () => {
    expect(pkg.bin).toEqual({ hypotenuse: "./dist/hypotenuse.js" });
    const raw = readFileSync(join(CLI_DIR, "package.json"), "utf8");
    expect(raw).not.toContain("workspace:");
    expect(raw).not.toContain("@hypotenuse/");
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });

  test("the bundle runs under Bun and imports only declared dependencies", () => {
    const bundle = readFileSync(join(CLI_DIR, "dist", "hypotenuse.js"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env bun")).toBe(true);
    const imports = new Set(
      [...bundle.matchAll(/from\s+"([^"./][^"]*)"/g)].map(
        (m) => m[1] as string,
      ),
    );
    const allowed = new Set([
      ...Object.keys(pkg.dependencies),
      "fs",
      "os",
      "path",
      "crypto",
      "url",
    ]);
    const stray = [...imports].filter(
      (spec) =>
        !allowed.has(spec) &&
        !spec.startsWith("node:") &&
        !spec.startsWith("bun:"),
    );
    expect(stray).toEqual([]);
  });
});
