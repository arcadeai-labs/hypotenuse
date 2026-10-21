/**
 * The `hypotenuse` program: global options and every command. Separate from
 * `cli.ts` so tests (the skill-sync check above all) can build it without
 * running it.
 */
import { Command } from "commander";
import pkg from "../package.json";
import { registerAuditCommands } from "./commands/audit";
import { registerAuthCommands } from "./commands/auth";
import { registerCheckUpdateCommand } from "./commands/check-update";
import { registerIntegrationCommands } from "./commands/integration";
import { registerInviteCommands } from "./commands/invite";
import { registerMemberCommands } from "./commands/member";
import { registerProjectCommands } from "./commands/project";
import { registerSessionCommands } from "./commands/session";
import { registerTagCommands } from "./commands/tag";
import { registerUpgradeCommand } from "./commands/upgrade";
import { banner } from "./output/theme";

/** Global options that take a value, for finding the command word in raw argv. */
export const VALUE_OPTIONS = ["-c", "--config", "--url", "--project"];

/**
 * Build the `hypotenuse` command-line program.
 * @returns The configured commander program, not yet parsed.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("hypotenuse")
    .description(pkg.description)
    .version(pkg.version, "-V, --version", "print the version")
    .option("-c, --config <path>", "the daemon config file")
    .option(
      "--url <origin>",
      "the Hypotenuse server (default: where you last logged in)",
    )
    .option(
      "--project <id|slug>",
      "the project to act on (default: `project use`)",
    )
    .option("-j, --json", "print machine-readable JSON on stdout")
    .option("-v, --verbose", "print each request on stderr")
    .option("--no-color", "disable colored output")
    // Read by `output/early-env` before parsing; declared so commander accepts it.
    .option("--force-color", "color output even when it is piped")
    .showHelpAfterError()
    .action(() => {
      console.log(banner(pkg.version));
      console.log("");
      program.outputHelp();
    });

  registerAuthCommands(program);
  registerProjectCommands(program);
  registerMemberCommands(program);
  registerInviteCommands(program);
  registerTagCommands(program);
  registerAuditCommands(program);
  registerIntegrationCommands(program);
  registerSessionCommands(program);
  registerCheckUpdateCommand(program);
  registerUpgradeCommand(program);
  return program;
}

/**
 * The first command word in raw argv, skipping global options and their values.
 * @param argv - Arguments after the program name.
 * @returns The command word, if any.
 */
export function firstCommandWord(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (VALUE_OPTIONS.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}
