/**
 * Flags that decide color have to be read before commander parses argv, because
 * output written while commander is still building the program (a usage error,
 * `--help`) must already obey them. This module translates `--no-color`,
 * `--json`, and `--force-color` into the `NO_COLOR` / `FORCE_COLOR` environment
 * variables that every later decision reads, so there is one input, not two.
 *
 * Import it first in `cli.ts`. The import applies the rules to the real process;
 * `applyEarlyEnv` is exported so tests can run the same rules on a copy.
 */

/**
 * Translate color-related argv flags into environment variables, in place.
 * `--no-color` and `--json` set `NO_COLOR` (keeping an existing value) and clear
 * `FORCE_COLOR`; an explicit
 * `--force-color` (with neither of those) sets `FORCE_COLOR` and clears `NO_COLOR`.
 * @param argv - Arguments after the program name.
 * @param env - The environment to mutate.
 * @returns The same `env`, for chaining in tests.
 */
export function applyEarlyEnv(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const has = (flag: string) => argv.includes(flag);
  const plain = has("--no-color") || has("--json") || has("-j");
  if (plain) {
    if (!env.NO_COLOR) env.NO_COLOR = "1";
    // A flag on this command line beats a FORCE_COLOR inherited from the shell.
    delete env.FORCE_COLOR;
  }
  if (has("--force-color") && !plain) {
    env.FORCE_COLOR = "1";
    delete env.NO_COLOR;
  }
  return env;
}

applyEarlyEnv(process.argv.slice(2), process.env);
