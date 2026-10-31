import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Every platform interaction is in its platform's coverage matrix
 * (`docs/platform-coverage/<platform>.md`), and every row's test file exists and
 * mentions the row's id — so a matrix row can never point at a test that
 * does not prove it.
 */
const root = path.join(import.meta.dir, "..", "..", "..");
const dir = path.join(root, "docs", "platform-coverage");

/**
 * The rows of a coverage table: id, module, and test.
 * @param text - The markdown.
 * @returns One entry per row.
 */
function rows(text: string) {
  return text
    .split("\n")
    .filter((l) => /^\| `[^`]+` \|/.test(l))
    .map((l) => {
      const cells = l.split("|").map((c) => c.trim());
      const unquote = (c: string) => c.replace(/^`|`$/g, "");
      return {
        id: unquote(cells[1]),
        module: unquote(cells[3]),
        test: unquote(cells[4]),
      };
    });
}

describe("platform coverage matrices", () => {
  test("every row names a module and a test that exist, and the test mentions the row", async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const table = rows(await Bun.file(path.join(dir, file)).text());
      expect(table.length, file).toBeGreaterThan(0);
      for (const row of table) {
        expect(
          await Bun.file(path.join(root, row.module)).exists(),
          `${file} ${row.id} module`,
        ).toBe(true);
        const testFile = Bun.file(path.join(root, row.test));
        expect(await testFile.exists(), `${file} ${row.id} test`).toBe(true);
        expect(
          (await testFile.text()).includes(row.id),
          `${row.test} mentions ${row.id}`,
        ).toBe(true);
      }
    }
  });
});
