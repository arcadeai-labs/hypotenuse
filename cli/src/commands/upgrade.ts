/**
 * `hypotenuse upgrade` — replace this install with the latest release, by
 * whichever method installed it.
 */
import type { Command } from "commander";
import type { Updater, UpgradeResult } from "upgradr";
import { emit, runCommand } from "../context";
import { logger } from "../output/logger";
import { updater } from "../update/updater";

/** What Windows binary installs run instead of an in-place swap. */
export const WINDOWS_REINSTALL =
  "irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex";

/** An upgrade's outcome, plus what to tell a person. */
export interface UpgradeOutcome {
  /** upgradr's result (`--json` prints it), with `reinstall` on Windows. */
  result: UpgradeResult & { reinstall?: string };
  /** The human message. */
  message: string;
  /** Whether the message is a failure (stderr) or not (stdout). */
  failed: boolean;
  /** 1 only when an attempted upgrade failed. */
  exitCode: number;
}

/**
 * Run an upgrade and decide what it means. Pure apart from the updater, which
 * tests construct with a stubbed registry.
 *
 * Windows cannot replace a running `.exe` and upgradr has no `mv` there, so a
 * Windows binary install is told to re-run the install script instead of
 * attempting the swap.
 * @param up - The updater.
 * @param platform - `process.platform`, injectable for the Windows case.
 * @returns The outcome.
 */
export async function performUpgrade(
  up: Updater,
  platform: string = process.platform,
): Promise<UpgradeOutcome> {
  const method = up.detectInstallMethod();
  let result: UpgradeOutcome["result"];

  if (platform === "win32" && method === "binary") {
    const info = await up.checkForUpdate();
    result = {
      method,
      from: info.currentVersion,
      to: info.latestVersion,
      hasUpdate: info.hasUpdate,
      performed: false,
      success: !info.error && !info.hasUpdate,
      ...(info.error ? { error: info.error } : {}),
      ...(info.hasUpdate ? { reinstall: WINDOWS_REINSTALL } : {}),
    };
    if (info.hasUpdate) {
      return {
        result,
        message: `hypotenuse v${result.to} is available. Windows cannot replace a running hypotenuse.exe; reinstall with:\n  ${WINDOWS_REINSTALL}`,
        failed: false,
        exitCode: 0,
      };
    }
  } else {
    result = await up.upgrade();
  }

  const exitCode = result.performed && !result.success ? 1 : 0;
  if (result.error && !result.performed) {
    return {
      result,
      message: `Could not check for updates: ${result.error}`,
      failed: true,
      exitCode,
    };
  }
  if (!result.hasUpdate) {
    return {
      result,
      message: `hypotenuse is already up to date (v${result.from})`,
      failed: false,
      exitCode,
    };
  }
  if (result.method === "local-dev") {
    return {
      result,
      message: "Running from source. Use `git pull && bun install` to update.",
      failed: false,
      exitCode,
    };
  }
  if (result.success) {
    return {
      result,
      message: `Upgraded hypotenuse v${result.from} → v${result.to}`,
      failed: false,
      exitCode,
    };
  }
  return {
    result,
    message: `Upgrade failed${result.error ? `: ${result.error}` : "."}`,
    failed: true,
    exitCode,
  };
}

/**
 * Register `upgrade`.
 * @param program - The root program.
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade hypotenuse to the latest release")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const spinner = logger.spinner("Checking for updates");
        let outcome: UpgradeOutcome;
        try {
          outcome = await performUpgrade(updater);
        } finally {
          spinner.stop();
        }
        if (ctx.json) {
          emit(ctx, outcome.result, () => "");
        } else if (outcome.failed) {
          logger.error(outcome.message);
        } else {
          console.log(outcome.message);
        }
        if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
      });
    });
}
