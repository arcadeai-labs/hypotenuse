/**
 * Where the CLI keeps its files. One directory, `$XDG_CONFIG_HOME/hypotenuse`
 * (else `~/.config/hypotenuse`), on every platform — the credentials file and
 * the update-check cache sit side by side, so "which file is it reading" has
 * one answer.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The CLI's config directory.
 * @param env - Environment variables (`process.env` in production).
 * @returns `$XDG_CONFIG_HOME/hypotenuse`, or `~/.config/hypotenuse`.
 */
export function configDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "hypotenuse");
}

/**
 * The credentials file: a sign-in and the selected organization and project,
 * per server.
 * @param env - Environment variables.
 * @returns Its path.
 */
export function credentialsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(configDir(env), "credentials.json");
}
