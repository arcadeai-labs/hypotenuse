import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfigWatcher,
  watchConfigFile,
} from "../../src/daemon/config-watch";

/**
 * The config watcher: one call per settled change, whether the editor writes
 * in place or renames a new file over the old one, and none for a save that
 * changes nothing or for a neighbour in the same directory.
 */

let watcher: ConfigWatcher | null = null;
afterEach(() => {
  watcher?.close();
  watcher = null;
});

/**
 * A config file in a fresh directory, watched with a short debounce.
 * @returns Its path and the number of changes reported so far.
 */
function watched() {
  const dir = mkdtempSync(join(tmpdir(), "hyp-watch-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, "config_version = 1\n");
  const seen = { changes: 0 };
  watcher = watchConfigFile(path, () => seen.changes++, { debounceMs: 30 });
  return { dir, path, seen };
}

/**
 * Wait until a count reaches a value, bounded.
 * @param read - The count.
 * @param value - The value.
 */
async function reaches(read: () => number, value: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (read() < value && Date.now() < deadline) await Bun.sleep(10);
  expect(read()).toBe(value);
}

describe("watchConfigFile", () => {
  test("a write in place is one change, however many events it makes", async () => {
    const { path, seen } = watched();
    writeFileSync(path, "config_version = 1\n# a\n");
    writeFileSync(path, "config_version = 1\n# ab\n");
    await reaches(() => seen.changes, 1);
    await Bun.sleep(100);
    expect(seen.changes).toBe(1);
  });

  test("a new file renamed over the old one is seen, and so is the next", async () => {
    const { dir, path, seen } = watched();
    for (const [i, body] of ["# one\n", "# two\n"].entries()) {
      const temp = join(dir, `.config.toml.swp${i}`);
      writeFileSync(temp, body);
      renameSync(temp, path);
      await reaches(() => seen.changes, i + 1);
    }
  });

  test("a save with the same bytes, a touch, or a neighbour is not a change", async () => {
    const { dir, path, seen } = watched();
    writeFileSync(path, "config_version = 1\n");
    utimesSync(path, new Date(), new Date());
    writeFileSync(join(dir, "credentials.json"), "{}");
    await Bun.sleep(200);
    expect(seen.changes).toBe(0);
  });

  test("a file deleted and written back is one change, once it is back", async () => {
    const { path, seen } = watched();
    rmSync(path);
    await Bun.sleep(100);
    expect(seen.changes).toBe(0);
    writeFileSync(path, "config_version = 1\n# back\n");
    await reaches(() => seen.changes, 1);
  });

  test("a directory that cannot be watched reports why and returns null", () => {
    const errors: unknown[] = [];
    const result = watchConfigFile(
      join(tmpdir(), "hyp-no-such-dir", "config.toml"),
      () => {},
      { onError: (e) => errors.push(e) },
    );
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
