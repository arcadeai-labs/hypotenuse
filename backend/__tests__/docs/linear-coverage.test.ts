import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `docs/LINEAR_COVERAGE.md` claims, row by row, that a Linear behaviour is
 * handled and names the test that proves it. A claim nobody checks drifts, so
 * this checks the part that is mechanical: every row is well-formed, every ID
 * is unique, and every row that says it is done names a test file that exists
 * and mentions the row's ID — in a test name or an `// LC-…` comment.
 *
 * A `planned` row's test file usually does not exist yet, so it is not
 * resolved. When conformance is finished, the last test here flips to refusing
 * any `planned` row at all.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MATRIX = readFileSync(join(REPO_ROOT, "docs/LINEAR_COVERAGE.md"), "utf8");

/** The statuses a row may carry. */
const STATUSES = [
  "planned",
  "planned (not applicable once confirmed)",
  "covered",
  "covered (finear gap)",
  "not applicable",
];

/** One parsed matrix row. */
interface Row {
  id: string;
  test: string;
  status: string;
  cells: number;
}

/**
 * Every `| LC-… |` row in the matrix.
 * @returns The parsed rows.
 */
function rows(): Row[] {
  return MATRIX.split("\n")
    .filter((line) => line.startsWith("| LC-"))
    .map((line) => {
      const cells = line
        .replace(/^\|\s*/, "")
        .replace(/\s*\|$/, "")
        .split(" | ");
      return {
        id: cells[0].trim(),
        test: (cells[5] ?? "").replace(/`/g, "").trim(),
        status: (cells[6] ?? "").trim(),
        cells: cells.length,
      };
    });
}

describe("docs/LINEAR_COVERAGE.md", () => {
  test("has rows, each with seven cells and a unique ID", () => {
    const all = rows();
    expect(all.length).toBeGreaterThan(100);
    for (const row of all) expect(row.cells, row.id).toBe(7);
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every status is a known one", () => {
    for (const row of rows()) {
      expect(STATUSES, row.id).toContain(row.status);
    }
  });

  test("every row that is not planned names a test that exists and mentions its ID", () => {
    const done = rows().filter((r) => !r.status.startsWith("planned"));
    expect(done.length).toBeGreaterThan(0);
    for (const row of done) {
      const path = join(REPO_ROOT, row.test);
      expect(existsSync(path), `${row.id}: ${row.test}`).toBe(true);
      expect(readFileSync(path, "utf8"), `${row.id}: ${row.test}`).toContain(
        row.id,
      );
    }
  });
});
