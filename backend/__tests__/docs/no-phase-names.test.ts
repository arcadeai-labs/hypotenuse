import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The build plan's phases are a schedule, not a fact about the system. Code,
 * tests, and user docs say what a thing is *for*, because that stays true after
 * the schedule is forgotten and survives the plan being reordered. Only
 * `docs/plans/` (and the builder docs that link into it) may name a phase.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Source trees a reader meets without the plan beside them. */
const SCANNED = [
  { dir: "backend", glob: "**/*.{ts,tsx,sql,json,md}" },
  { dir: "frontend/src", glob: "**/*.{ts,tsx,css,scss,md}" },
  { dir: "cli", glob: "**/*.{ts,tsx,md,json}" },
  { dir: "protocol", glob: "**/*.{ts,md,json}" },
];

/** Paths that are not ours to police. */
const IGNORED =
  /(^|\/)(node_modules|\.finear|dist|\.cache|drizzle\/meta)(\/|$)/;

const PHASE = /\b[Pp]hase \d+\b/;

describe("no phase names outside the plans", () => {
  test("no source file or user doc names a plan phase", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const { dir, glob } of SCANNED) {
      const cwd = join(REPO_ROOT, dir);
      for (const file of new Bun.Glob(glob).scanSync({ cwd })) {
        if (IGNORED.test(file)) continue;
        scanned++;
        const lines = readFileSync(join(cwd, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          // This file has to spell the pattern it forbids.
          if (file.endsWith("no-phase-names.test.ts")) return;
          if (PHASE.test(line)) offenders.push(`${dir}/${file}:${i + 1}`);
        });
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
