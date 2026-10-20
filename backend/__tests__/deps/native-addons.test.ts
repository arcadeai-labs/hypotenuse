import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing in this install compiles a native addon.
 *
 * An addon calling a libuv function Bun has not implemented on POSIX takes the
 * process down uncatchably (oven-sh/bun#18546), and whether it fires depends on
 * which `node` compiled it — so it hides locally and crashes somewhere else.
 * The root `trustedDependencies` **replaces** Bun's default trust list, so only
 * the packages named there may run an install script. Keeping that list to
 * `esbuild` is the guard; these assertions are about the install, so the next
 * native dependency to arrive inherits the protection.
 */

/** The repository root, two levels above `backend/__tests__`. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Every directory an install may place packages in. */
const INSTALL_ROOTS = ["", "backend", "frontend", "cli", "protocol"].map(
  (workspace) => join(REPO_ROOT, workspace, "node_modules"),
);

/** Where `node-gyp` leaves what it compiled. */
const GYP_OUTPUT = "**/build/{Release,Debug}/*.node";

/** The root manifest, which is the only one Bun reads a trust list from. */
const rootManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { trustedDependencies?: string[] };

describe("native addons", () => {
  test("the root manifest trusts exactly esbuild", () => {
    // Presence is the mechanism: with no `trustedDependencies` key at all, Bun
    // falls back to its own default list.
    expect(rootManifest.trustedDependencies).toEqual(["esbuild"]);
  });

  test("the install produced no compiled addon at all", () => {
    const glob = new Bun.Glob(GYP_OUTPUT);
    const found: string[] = [];
    for (const root of INSTALL_ROOTS) {
      if (!existsSync(root)) continue;
      for (const hit of glob.scanSync({
        cwd: root,
        onlyFiles: true,
        dot: true,
      })) {
        found.push(join(root, hit));
      }
    }
    expect(found).toEqual([]);
  });
});
