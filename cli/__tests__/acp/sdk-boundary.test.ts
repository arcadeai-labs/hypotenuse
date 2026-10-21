import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";

/**
 * The ACP SDK is pinned exactly and imported by one module, so an SDK major
 * version touches one file.
 */
describe("acp sdk boundary", () => {
  test("pinned to an exact version", () => {
    expect(pkg.dependencies["@agentclientprotocol/sdk"]).toBe("2.0.0");
  });

  test("only src/acp/connection.ts imports it", () => {
    const src = join(import.meta.dir, "..", "..", "src");
    const importers = Array.from(
      new Bun.Glob("**/*.ts").scanSync({ cwd: src }),
    ).filter((file) =>
      /from\s+["']@agentclientprotocol\/sdk/.test(
        readFileSync(join(src, file), "utf8"),
      ),
    );
    expect(importers).toEqual(["acp/connection.ts"]);
  });
});
