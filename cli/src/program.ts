/**
 * The `hypotenuse` program. Separate from `cli.ts` so tests can build it
 * without running it.
 */
import { Command } from "commander";
import pkg from "../package.json";

/**
 * Build the `hypotenuse` command tree.
 *
 * It is an operator client over HTTP: every command it grows calls the server's
 * API, so nothing here may import the server itself.
 * @returns The configured commander program, not yet parsed.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("hypotenuse")
    .description(pkg.description)
    .version(pkg.version, "-v, --version", "print the CLI version");
  // Bare `hypotenuse` shows what it can do, rather than exiting silently.
  program.action(() => program.help());
  return program;
}
