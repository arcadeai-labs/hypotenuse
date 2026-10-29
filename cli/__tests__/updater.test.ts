import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdater } from "upgradr";
import pkg from "../package.json";
import {
  BACKGROUND_SKIP_COMMANDS,
  BINARY_NAME,
  GITHUB_REPO,
  updaterConfig,
} from "../src/update/updater";

/**
 * A stand-in for the npm registry and GitHub: answers `latest` for the
 * package and 404 for everything else.
 * @param latest - The version the registry reports.
 * @returns A fetch-compatible function.
 */
export function registryAt(latest: string) {
  return async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("registry.npmjs.org")) {
      return Response.json({ name: pkg.name, version: latest });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("updater wiring", () => {
  test("repository.url is exactly the repo the binaries are released from", () => {
    expect(pkg.repository.url).toBe(
      "https://github.com/arcadeai-labs/hypotenuse.git",
    );
    expect(GITHUB_REPO).toBe("arcadeai-labs/hypotenuse");
  });

  test("the first bin key names the binary and every release asset", () => {
    expect(Object.keys(pkg.bin)).toEqual(["hypotenuse"]);
    expect(BINARY_NAME).toBe("hypotenuse");
    expect(pkg.name).toBe("@arcadeai/hypotenuse");
  });

  test("the update commands never show the notice", () => {
    expect([...BACKGROUND_SKIP_COMMANDS].sort()).toEqual(
      ["check-update", "upgrade"].sort(),
    );
  });

  test("the background notice appears for an interactive command and not for the others", async () => {
    const up = () =>
      createUpdater(
        updaterConfig({
          cacheDir: mkdtempSync(join(tmpdir(), "hyp-upd-")),
          fetchImpl: registryAt("99.0.0"),
        }),
      );
    const argv = (...rest: string[]) => ["bun", "hypotenuse", ...rest];
    const tty = { env: {}, isTTY: true };

    const shown = await up().maybeBackgroundNotice({
      ...tty,
      argv: argv("project", "list"),
    });
    expect(shown).toContain("99.0.0");
    expect(shown).toContain("hypotenuse upgrade");

    for (const command of ["upgrade", "check-update"]) {
      expect(
        await up().maybeBackgroundNotice({ ...tty, argv: argv(command) }),
        command,
      ).toBeNull();
    }
    expect(
      await up().maybeBackgroundNotice({
        env: { HYPOTENUSE_NO_UPDATE_CHECK: "1" },
        isTTY: true,
        argv: argv("whoami"),
      }),
    ).toBeNull();
    expect(
      await up().maybeBackgroundNotice({
        env: {},
        isTTY: false,
        argv: argv("whoami"),
      }),
    ).toBeNull();
  });
});
