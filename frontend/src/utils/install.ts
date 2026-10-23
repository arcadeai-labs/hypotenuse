/** One way to install the `hypotenuse` CLI. */
export interface InstallCommand {
  /** Who it is for, e.g. "macOS / Linux". */
  label: string;
  /** The shell line to run. */
  command: string;
}

/**
 * The ways to install the CLI, as the README documents them. The home page and
 * the register-a-runner modal both show these; a test holds them to the README.
 */
export const INSTALL_COMMANDS: InstallCommand[] = [
  {
    label: "macOS / Linux",
    command:
      "curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash",
  },
  {
    label: "Windows (PowerShell)",
    command:
      "irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex",
  },
  {
    label: "npm (requires Bun)",
    command: "bun install -g @arcadeai/hypotenuse",
  },
];
