/**
 * The `Co-Authored-By` trailer on a coding agent's commits.
 *
 * Commits are the person's: the agent runs on their machine, with their git
 * identity and credentials, and nothing on a developer machine can make it
 * push as anyone else. The trailer says the other half — an agent wrote it —
 * without a credential.
 *
 * It is added by a `commit-msg` hook that reaches only the agent: git reads
 * `core.hooksPath` from `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n` in the agent's environment, so the person's checkout,
 * its config, and their own commits are untouched. Pointing `core.hooksPath`
 * away hides the repository's own hooks, so every client hook here is a shim
 * that runs the repository's — found by asking git again without our entry —
 * and the repository's `commit-msg` runs before the trailer is added, so it
 * validates what the agent wrote. `git commit --no-verify` skips both.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every hook git runs by name in a checkout, or in a local repository pushed
 * to (receive-pack inherits the pusher's environment). `fsmonitor-watchman`
 * is absent: git runs it only when `core.fsmonitor` names it.
 */
export const GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
  "reference-transaction",
  "push-to-checkout",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
] as const;

/**
 * The shim every hook name runs. `HYPOTENUSE_GIT_CONFIG_COUNT` is the count of
 * environment config entries before ours, so `git rev-parse --git-path hooks`
 * under it answers the repository's own hooks directory (`core.hooksPath`, or
 * the common `.git/hooks`).
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Written by the Hypotenuse daemon for its coding agents. Runs the repository's
# own hook, then adds the Co-Authored-By trailer to a commit message.
name=$(basename "$0")
own=$(GIT_CONFIG_COUNT="\${HYPOTENUSE_GIT_CONFIG_COUNT:-0}" git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$own" ] && [ -x "$own/$name" ] && ! [ "$own" -ef "$(dirname "$0")" ]; then
  if [ "$name" != commit-msg ]; then
    exec "$own/$name" "$@"
  fi
  "$own/$name" "$@" || exit $?
fi
if [ "$name" = commit-msg ] && [ -n "$HYPOTENUSE_CO_AUTHOR" ]; then
  git interpret-trailers --in-place --if-exists addIfDifferent \\
    --trailer "Co-Authored-By: $HYPOTENUSE_CO_AUTHOR" "$1"
fi
exit 0
`;

/**
 * Write the shims into the daemon's state directory. Each file is written
 * whole and renamed into place, so a turn starting while another writes never
 * runs half a script.
 * @param stateDir - The daemon's state directory.
 * @returns The hooks directory.
 */
export function installCoAuthorHooks(stateDir: string): string {
  const dir = join(stateDir, "git-hooks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of GIT_HOOK_NAMES) {
    const path = join(dir, name);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, HOOK_SCRIPT, { mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, path);
  }
  return dir;
}

/**
 * The variables that point an agent's git at the shims and name the
 * co-author, appended after any `GIT_CONFIG_*` entries the environment
 * already carries.
 * @param env - The agent's environment so far.
 * @param hooksDir - From {@link installCoAuthorHooks}.
 * @param coAuthor - `Name <email>`.
 * @returns The variables to add.
 */
export function coAuthorEnvironment(
  env: Record<string, string | undefined>,
  hooksDir: string,
  coAuthor: string,
): Record<string, string> {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: hooksDir,
    HYPOTENUSE_GIT_CONFIG_COUNT: String(count),
    HYPOTENUSE_CO_AUTHOR: coAuthor,
  };
}
