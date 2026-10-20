/**
 * Self-update, through upgradr — the same machinery as mcpx.
 *
 * - "Latest" comes from npm (`@arcadeai/hypotenuse`), even for binary installs;
 *   the changelog comes from GitHub Releases. The release workflow therefore
 *   publishes npm and the binaries from one version or neither.
 * - The install method is detected from `process.execPath` and the script
 *   path: a compiled binary, `bun -g`, `npm -g`, or a source checkout
 *   (`local-dev`, a no-op).
 * - A binary upgrade downloads `hypotenuse-<os>-<arch>[.exe]` for `v<latest>`
 *   and moves it over `process.execPath`.
 *
 * The GitHub repo and the asset prefix are derived from `package.json` — its
 * `repository.url` and its first `bin` key — so there is one source of truth,
 * and `updater.test.ts` asserts both.
 */
import { createUpdater, type UpdaterConfig } from "upgradr";
import pkg from "../../package.json";
import { configDir } from "../paths";

/** `owner/name` of the repository whose releases carry the binaries. */
export const GITHUB_REPO = pkg.repository.url
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

/** The executable's name, and the prefix of every release asset. */
export const BINARY_NAME = Object.keys(pkg.bin)[0] as string;

/** Set to `1` to turn off the background update check. */
export const NO_UPDATE_CHECK_ENV = "HYPOTENUSE_NO_UPDATE_CHECK";

/**
 * Commands that never show the background notice: the update commands
 * themselves, and the daemon and MCP server, which are not interactive and
 * whose stderr may be a log file or an agent's pipe.
 */
export const BACKGROUND_SKIP_COMMANDS = [
  "check-update",
  "upgrade",
  "daemon",
  "mcp",
];

/**
 * The upgradr configuration for this CLI.
 * @param overrides - Fields to replace (tests inject `fetchImpl` and `cacheDir`).
 * @returns The configuration.
 */
export function updaterConfig(
  overrides: Partial<UpdaterConfig> = {},
): UpdaterConfig {
  return {
    currentVersion: pkg.version,
    packageName: pkg.name,
    repo: GITHUB_REPO,
    binaryName: BINARY_NAME,
    cacheDir: configDir(),
    cliName: BINARY_NAME,
    noUpdateCheckEnv: NO_UPDATE_CHECK_ENV,
    checkIntervalMs: 24 * 60 * 60 * 1000,
    timeoutMs: 5_000,
    backgroundSkipCommands: BACKGROUND_SKIP_COMMANDS,
    ...overrides,
  };
}

/** The process-wide updater. */
export const updater = createUpdater(updaterConfig());
