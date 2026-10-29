/**
 * `hypotenuse check-update` — is there a newer release, and what changed.
 */
import type { Command } from "commander";
import { emit, runCommand } from "../context";
import { logger } from "../output/logger";
import { dim } from "../output/theme";
import { updater } from "../update/updater";
import { crossesMajor } from "./upgrade";

/**
 * Register `check-update`.
 * @param program - The root program.
 */
export function registerCheckUpdateCommand(program: Command): void {
  program
    .command("check-update")
    .description("Check for a newer release of hypotenuse")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const spinner = logger.spinner("Checking for updates");
        let info: Awaited<ReturnType<typeof updater.checkForUpdate>>;
        try {
          info = await updater.checkForUpdate();
        } finally {
          spinner.stop();
        }
        // Only a completed check is cached, so a failed one never hides the
        // next background notice.
        if (!info.error) {
          await updater.saveCache({
            lastCheckAt: new Date().toISOString(),
            latestVersion: info.latestVersion,
            hasUpdate: info.hasUpdate,
            changelog: info.changelog,
          });
        }
        emit(ctx, info, () => {
          if (info.error) return `Could not check for updates: ${info.error}`;
          if (!info.hasUpdate) {
            return info.aheadOfLatest
              ? `hypotenuse v${info.currentVersion} is ahead of the latest release (v${info.latestVersion})`
              : `hypotenuse is up to date (v${info.currentVersion})`;
          }
          return [
            `Update available: ${info.currentVersion} → ${info.latestVersion}`,
            ...(info.changelog ? ["", dim(info.changelog)] : []),
            "",
            crossesMajor(info.currentVersion, info.latestVersion)
              ? "A new major version. Read its release notes, then run `hypotenuse upgrade --major`"
              : "Run `hypotenuse upgrade` to update",
          ].join("\n");
        });
      });
    });
}
