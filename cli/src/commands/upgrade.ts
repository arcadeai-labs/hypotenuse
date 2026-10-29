/**
 * `hypotenuse upgrade` — replace this install with the latest release, by
 * whichever method installed it.
 *
 * A new major version is refused without `--major`. upgradr has no option for
 * that, so the guard is a check first: `checkForUpdate`, compare majors, and
 * only then `upgrade` (which checks again itself, never trusting a cache).
 */
import type { Command } from "commander";
import type { UpdateInfo, Updater, UpgradeResult } from "upgradr";
import { emit, runCommand } from "../context";
import { logger } from "../output/logger";
import { updater } from "../update/updater";

/** What Windows binary installs run instead of an in-place swap. */
export const WINDOWS_REINSTALL =
  "irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex";

/** An upgrade's outcome, plus what to tell a person. */
export interface UpgradeOutcome {
  /**
   * upgradr's result (`--json` prints it), with `reinstall` on Windows and
   * `blockedByMajor` when the major-version guard held it back.
   */
  result: UpgradeResult & { reinstall?: string; blockedByMajor?: boolean };
  /** The human message. */
  message: string;
  /** Whether the message is a failure (stderr) or not (stdout). */
  failed: boolean;
  /** 1 only when an attempted upgrade failed. */
  exitCode: number;
}

/**
 * The major version of a semver string.
 * @param version - e.g. `2.0.0` or `v2.1.0-beta.1`.
 * @returns The major number, or NaN when it does not parse.
 */
export function majorOf(version: string): number {
  return Number(/^v?(\d+)\./.exec(version)?.[1] ?? Number.NaN);
}

/**
 * Whether going from one version to another crosses a major version upward.
 * @param from - The running version.
 * @param to - The latest version.
 * @returns True for `1.x` → `2.x`, false within a major or when either does not parse.
 */
export function crossesMajor(from: string, to: string): boolean {
  const a = majorOf(from);
  const b = majorOf(to);
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

/**
 * A result for an upgrade that was never attempted, built from a check.
 * @param method - How the CLI was installed.
 * @param info - The check.
 * @returns The result.
 */
function unattempted(
  method: UpgradeResult["method"],
  info: UpdateInfo,
): UpgradeResult {
  return {
    method,
    from: info.currentVersion,
    to: info.latestVersion,
    hasUpdate: info.hasUpdate,
    performed: false,
    success: !info.error && !info.hasUpdate,
    ...(info.error ? { error: info.error } : {}),
  };
}

/**
 * Run an upgrade and decide what it means. Pure apart from the updater, which
 * tests construct with a stubbed registry.
 *
 * | Check says | `--major` | Windows binary | Does |
 * |---|---|---|---|
 * | error | either | either | nothing; "Could not check for updates" |
 * | no update | either | either | nothing; "already up to date" |
 * | update in the same major | either | no | upgrades |
 * | update in the same major | either | yes | prints the reinstall command |
 * | update across a major | no | either | nothing; says why and how |
 * | update across a major | yes | no | upgrades |
 * | update across a major | yes | yes | prints the reinstall command |
 *
 * Windows cannot replace a running `.exe` and upgradr has no `mv` there, so a
 * Windows binary install is told to re-run the install script instead.
 * @param up - The updater.
 * @param options.major - Whether crossing a major version is allowed.
 * @param options.platform - `process.platform`, injectable for the Windows case.
 * @returns The outcome.
 */
export async function performUpgrade(
  up: Updater,
  options: { major?: boolean; platform?: string } = {},
): Promise<UpgradeOutcome> {
  const platform = options.platform ?? process.platform;
  const method = up.detectInstallMethod();
  const info = await up.checkForUpdate();

  if (info.error) {
    return {
      result: unattempted(method, info),
      message: `Could not check for updates: ${info.error}`,
      failed: true,
      exitCode: 0,
    };
  }
  if (!info.hasUpdate) {
    return {
      result: unattempted(method, info),
      message: `hypotenuse is already up to date (v${info.currentVersion})`,
      failed: false,
      exitCode: 0,
    };
  }
  if (
    method !== "local-dev" &&
    !options.major &&
    crossesMajor(info.currentVersion, info.latestVersion)
  ) {
    return {
      result: { ...unattempted(method, info), blockedByMajor: true },
      message: `hypotenuse v${info.latestVersion} is a new major version; it may remove commands you use (see its release notes). Run \`hypotenuse upgrade --major\` to upgrade from v${info.currentVersion}.`,
      failed: false,
      exitCode: 0,
    };
  }
  if (platform === "win32" && method === "binary") {
    return {
      result: { ...unattempted(method, info), reinstall: WINDOWS_REINSTALL },
      message: `hypotenuse v${info.latestVersion} is available. Windows cannot replace a running hypotenuse.exe; reinstall with:\n  ${WINDOWS_REINSTALL}`,
      failed: false,
      exitCode: 0,
    };
  }

  const result = await up.upgrade();
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
    .option("--major", "allow upgrading to a new major version")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { major } = this.opts() as { major?: boolean };
        const spinner = logger.spinner("Checking for updates");
        let outcome: UpgradeOutcome;
        try {
          outcome = await performUpgrade(updater, { major });
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
