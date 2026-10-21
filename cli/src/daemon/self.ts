/**
 * How the daemon starts another copy of itself — the background start and
 * the re-exec after an upgrade — whether it is a compiled binary, the npm
 * bundle under Bun, or `src/cli.ts` in a checkout.
 */

/**
 * The command that runs this program again, without arguments.
 * @param argv - `process.argv`.
 * @param execPath - `process.execPath`.
 * @returns `[binary]` for a compiled build, else `[bun, script]`.
 */
export function selfCommand(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  const script = argv[1];
  // A compiled binary's script lives in Bun's embedded filesystem.
  if (
    !script ||
    script.startsWith("/$bunfs/") ||
    /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script) ||
    script === execPath
  ) {
    return [execPath];
  }
  return [execPath, script];
}

/**
 * The arguments a daemon was started with, made into a background child's:
 * `--foreground --detached-child` present exactly once.
 * @param args - The arguments after the program.
 * @returns The child's arguments.
 */
export function childArgs(args: readonly string[]): string[] {
  const kept = args.filter(
    (a) => a !== "--foreground" && a !== "--detached-child",
  );
  return [...kept, "--foreground", "--detached-child"];
}
