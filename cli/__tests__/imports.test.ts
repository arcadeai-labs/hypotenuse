import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CLI ships as a compiled binary on people's laptops. It may import the
 * shared protocol, never the server's framework or drivers — a binary that
 * carried Keryx, Drizzle, Postgres, and Redis clients would be large, and the
 * first server-only import deep in a module would break `--compile` for one
 * platform only.
 */
const FORBIDDEN = [/^keryx(\/|$)/, /^drizzle-orm(\/|$)/, /^pg$/, /^ioredis$/];

const SRC = join(import.meta.dir, "..", "src");

/**
 * Every module specifier imported by a source file, with whether it is type-only.
 * @param source - File contents.
 * @returns The import specifiers.
 */
function importsOf(source: string): { spec: string; typeOnly: boolean }[] {
  const found: { spec: string; typeOnly: boolean }[] = [];
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) {
    const spec = m[3] ?? m[4];
    if (spec) found.push({ spec, typeOnly: Boolean(m[2]) });
  }
  return found;
}

describe("cli import boundary", () => {
  const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: SRC }));

  test("there is source to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no server framework, driver, or backend value import", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      for (const { spec, typeOnly } of importsOf(source)) {
        if (FORBIDDEN.some((re) => re.test(spec)))
          offenders.push(`${file}: ${spec}`);
        if (spec.startsWith("@backend/") && !typeOnly)
          offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
