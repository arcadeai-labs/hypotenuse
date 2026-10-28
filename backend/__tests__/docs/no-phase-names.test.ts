import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The repository root, three levels above this file. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * The build plan's phases are a schedule, not a fact about the system. Code,
 * tests, and user docs say what a thing is *for*, because that stays true after
 * the schedule is forgotten. Only the builder docs may name a phase.
 */
describe("no phase names outside the plans", () => {
  /** Source trees a reader meets without the plan beside them. */
  const SCANNED = [
    { dir: "design", glob: "**/*.{ts,json,md}" },
    { dir: "backend", glob: "**/*.{ts,tsx,sql,json,md}" },
    { dir: "frontend/src", glob: "**/*.{ts,tsx,css,scss,md}" },
    { dir: "cli", glob: "**/*.{ts,tsx,md,json}" },
  ];

  /** Paths that are not ours to police. */
  const IGNORED =
    /(^|\/)(node_modules|\.finear|dist|\.cache|drizzle\/meta)(\/|$)/;

  const PHASE = /\b[Pp]hase \d+\b/;

  test("no source file or user doc names a plan phase", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const { dir, glob } of SCANNED) {
      const cwd = join(REPO_ROOT, dir);
      if (!existsSync(cwd)) continue;
      for (const file of new Bun.Glob(glob).scanSync({ cwd })) {
        if (IGNORED.test(file)) continue;
        // This file has to spell the pattern it forbids.
        if (file.endsWith("no-phase-names.test.ts")) continue;
        scanned++;
        const lines = readFileSync(join(cwd, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (PHASE.test(line)) offenders.push(`${dir}/${file}:${i + 1}`);
        });
      }
    }
    // Guard the guard: a glob that silently matched nothing would pass.
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
