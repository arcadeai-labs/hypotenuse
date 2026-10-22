/**
 * The `hypotenuse` program: global options and every command. Separate from
 * `cli.ts` so tests (the skill-sync check above all) can build it without
 * running it.
 */
import { Command } from "commander";
import pkg from "../package.json";
import { registerAgentsCommands } from "./commands/agents";
import { registerAuditCommands } from "./commands/audit";
import { registerAuthCommands } from "./commands/auth";
import { registerCheckUpdateCommand } from "./commands/check-update";
import { registerConfigCommands } from "./commands/config";
import { registerDaemonCommands } from "./commands/daemon";
import { registerDoctorCommand } from "./commands/doctor";
import { registerEventCommands } from "./commands/event";
import { registerIdentityCommands } from "./commands/identity";
import { registerIntegrationCommands } from "./commands/integration";
import { registerInviteCommands } from "./commands/invite";
import { registerMcpCommand } from "./commands/mcp";
import { registerMemberCommands } from "./commands/member";
import { registerProjectCommands } from "./commands/project";
import { registerRoutingCommands } from "./commands/routing";
import { registerRunnerCommands } from "./commands/runner";
import { registerServiceCommands } from "./commands/service";
import { registerSessionCommands } from "./commands/session";
import { registerTagCommands } from "./commands/tag";
import { registerTelemetryCommands } from "./commands/telemetry";
import { registerUpgradeCommand } from "./commands/upgrade";
import { registerWorktreesCommands } from "./commands/worktrees";
import { banner } from "./output/theme";

/** Global options that take a value, for finding the command word in raw argv. */
export const VALUE_OPTIONS = [
  "-c",
  "--config",
  "--state-dir",
  "--url",
  "--project",
];

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
      "--state-dir <path>",
      "the daemon's state directory (default: beside a -c config, else ~/.local/state/hypotenuse)",
    )
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
  registerEventCommands(program);
  registerRunnerCommands(program);
  registerRoutingCommands(program);
  registerTelemetryCommands(program);
  registerIdentityCommands(program);
  registerConfigCommands(program);
  registerDaemonCommands(program);
  registerAgentsCommands(program);
  registerWorktreesCommands(program);
  registerServiceCommands(program);
  registerDoctorCommand(program);
  registerCheckUpdateCommand(program);
  registerUpgradeCommand(program);
  registerMcpCommand(program);
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
