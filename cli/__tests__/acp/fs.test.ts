import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinedFs, OutsideWorktree } from "../../src/acp/fs";

/** `fs/*` confined to the worktree and the role's additional directories. */

/** A worktree, a sibling outside it, and an extra directory. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), "hyp-fs-"));
  const work = join(root, "work");
  const outside = join(root, "outside");
  const extra = join(root, "extra");
  for (const d of [work, outside, extra]) mkdirSync(d);
  writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\nfour");
  writeFileSync(join(outside, "secret.txt"), "nope");
  writeFileSync(join(extra, "shared.txt"), "shared");
  symlinkSync(outside, join(work, "escape"));
  return { root, work, outside, extra };
}

describe("confined fs", () => {
  test("reads inside the worktree, with line and limit", () => {
    const { work } = layout();
    const fs = new ConfinedFs([work]);
    expect(fs.read(join(work, "a.txt"))).toBe("one\ntwo\nthree\nfour");
    expect(fs.read("a.txt", 2, 2)).toBe("two\nthree");
  });

  test("refuses ../, absolute paths outside, and symlinks out", () => {
    const { work, outside } = layout();
    const fs = new ConfinedFs([work]);
    expect(() => fs.read("../outside/secret.txt")).toThrow(OutsideWorktree);
    expect(() => fs.read(join(outside, "secret.txt"))).toThrow(
      "outside the session worktree",
    );
    expect(() => fs.read(join(work, "escape", "secret.txt"))).toThrow(
      OutsideWorktree,
    );
    expect(() => fs.write(join(work, "escape", "new.txt"), "x")).toThrow(
      OutsideWorktree,
    );
    expect(() => fs.write("../outside/new.txt", "x")).toThrow(OutsideWorktree);
  });

  test("writes create parent directories, atomically", () => {
    const { work } = layout();
    const fs = new ConfinedFs([work]);
    fs.write("deep/dir/b.txt", "hello");
    expect(readFileSync(join(work, "deep", "dir", "b.txt"), "utf8")).toBe(
      "hello",
    );
    fs.write(join(work, "a.txt"), "replaced");
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("replaced");
  });

  test("additional directories are allowed", () => {
    const { work, extra } = layout();
    const fs = new ConfinedFs([work, extra]);
    expect(fs.read(join(extra, "shared.txt"))).toBe("shared");
    fs.write(join(extra, "out.txt"), "ok");
    expect(readFileSync(join(extra, "out.txt"), "utf8")).toBe("ok");
  });
});
