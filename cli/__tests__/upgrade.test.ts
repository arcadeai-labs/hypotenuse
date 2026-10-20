import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdater, type Updater, type UpgradeResult } from "upgradr";
import pkg from "../package.json";
import { performUpgrade, WINDOWS_REINSTALL } from "../src/commands/upgrade";
import { updaterConfig } from "../src/update/updater";
import { registryAt } from "./updater.test";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * An updater whose install method and outcomes are scripted, standing in for
 * upgradr where a real upgrade would install software on this machine.
 * @param over - The behaviors to script.
 * @returns The updater.
 */
function scripted(over: Partial<Updater>): Updater {
  const real = createUpdater(
    updaterConfig({
      cacheDir: mkdtempSync(join(tmpdir(), "hyp-up-")),
      fetchImpl: registryAt(pkg.version),
    }),
  );
  return { ...real, ...over };
}

/**
 * A full upgrade result.
 * @param over - Fields to set.
 * @returns The result.
 */
function result(over: Partial<UpgradeResult>): UpgradeResult {
  return {
    method: "npm",
    from: "1.0.0",
    to: "1.1.0",
    hasUpdate: true,
    performed: true,
    success: true,
    ...over,
  };
}

describe("hypotenuse upgrade", () => {
  test("from a checkout it is a no-op that exits 0 with method local-dev", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--json", "upgrade"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "hyp-up-")),
      },
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    const json = JSON.parse(stdout) as UpgradeResult;
    // Whether or not the registry answered, a checkout is never upgraded in place.
    expect(json.method).toBe("local-dev");
    expect(json.from).toBe(pkg.version);
    expect(json.performed).toBe(false);
    expect(typeof json.success).toBe("boolean");
  });

  test("already current says so and exits 0", async () => {
    const outcome = await performUpgrade(
      createUpdater(
        updaterConfig({
          cacheDir: mkdtempSync(join(tmpdir(), "hyp-up-")),
          fetchImpl: registryAt(pkg.version),
        }),
      ),
    );
    expect(outcome.message).toBe(
      `hypotenuse is already up to date (v${pkg.version})`,
    );
    expect(outcome.exitCode).toBe(0);
  });

  test("local-dev with a newer release explains, and exits 0", async () => {
    const outcome = await performUpgrade(
      scripted({
        upgrade: async () =>
          result({ method: "local-dev", performed: false, success: false }),
      }),
    );
    expect(outcome.message).toContain("git pull && bun install");
    expect(outcome.exitCode).toBe(0);
  });

  test("a success names both versions; only an attempted failure exits 1", async () => {
    const ok = await performUpgrade(
      scripted({ upgrade: async () => result({}) }),
    );
    expect(ok.message).toBe("Upgraded hypotenuse v1.0.0 → v1.1.0");
    expect(ok.exitCode).toBe(0);

    const failed = await performUpgrade(
      scripted({
        upgrade: async () => result({ success: false, error: "EACCES" }),
      }),
    );
    expect(failed.message).toBe("Upgrade failed: EACCES");
    expect(failed.failed).toBe(true);
    expect(failed.exitCode).toBe(1);

    const unreachable = await performUpgrade(
      scripted({
        upgrade: async () =>
          result({
            hasUpdate: false,
            performed: false,
            success: false,
            error: "offline",
          }),
      }),
    );
    expect(unreachable.message).toBe("Could not check for updates: offline");
    expect(unreachable.exitCode).toBe(0);
  });

  test("a Windows binary prints the reinstall line and never attempts the swap", async () => {
    let attempted = false;
    const up = scripted({
      detectInstallMethod: () => "binary",
      checkForUpdate: async () => ({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        hasUpdate: true,
        aheadOfLatest: false,
      }),
      upgrade: async () => {
        attempted = true;
        return result({});
      },
    });
    const outcome = await performUpgrade(up, "win32");
    expect(attempted).toBe(false);
    expect(outcome.message).toContain(WINDOWS_REINSTALL);
    expect(WINDOWS_REINSTALL).toBe(
      "irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex",
    );
    expect(outcome.result).toMatchObject({
      method: "binary",
      from: "1.0.0",
      to: "1.1.0",
      performed: false,
      reinstall: WINDOWS_REINSTALL,
    });
    expect(outcome.exitCode).toBe(0);

    // The same install on macOS or Linux does attempt it.
    await performUpgrade(up, "linux");
    expect(attempted).toBe(true);
  });
});
