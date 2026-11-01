import type { OpenInstallation } from "../platforms/types";
import type { BotInstallation } from "../schema/bot_installations";
import { decryptSecret, encryptSecret } from "./CryptoOps";

/**
 * An installation's sealed credentials, opened and sealed. Kept apart from
 * `InstallationOps` (which reads the adapter registry) so a platform's own
 * ops can use them without an import cycle through the registry.
 */

/**
 * Open an installation's sealed credentials.
 * @param installation - The row.
 * @returns The row and its credentials (`{}` when none are set yet).
 */
export function openInstallation(
  installation: BotInstallation,
): OpenInstallation {
  const credentials = installation.credentials
    ? (JSON.parse(decryptSecret(installation.credentials)) as Record<
        string,
        unknown
      >)
    : {};
  return { installation, credentials };
}

/**
 * Seal credentials for storage.
 * @param credentials - The adapter's credential document.
 * @returns The sealed record.
 */
export function sealCredentials(credentials: Record<string, unknown>) {
  return encryptSecret(JSON.stringify(credentials));
}
