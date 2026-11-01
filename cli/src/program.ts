/**
 * The `hypotenuse` program: global options and every command. Separate from
 * `cli.ts` so tests (the skill-sync check above all) can build it without
 * running it.
 *
 * It is an operator client over HTTP: every command calls the server's API, so
 * nothing here may import the server itself.
 */
import { Command } from "commander";
import pkg from "../package.json";
import { registerApprovalCommands } from "./commands/approval";
import { registerAuditCommands } from "./commands/audit";
import { registerAuthCommands } from "./commands/auth";
import { registerBotCommands } from "./commands/bot";
import {
  registerBindingCommands,
  registerChannelCommands,
} from "./commands/channel";
import { registerCheckUpdateCommand } from "./commands/check-update";
import { registerCodeRunCommands } from "./commands/code-run";
import { registerConversationCommands } from "./commands/conversation";
import { registerGoalCommands } from "./commands/goal";
import { registerHelpRequestCommands } from "./commands/help-request";
import { registerInstallationCommands } from "./commands/installation";
import { registerInviteCommands } from "./commands/invite";
import { registerLargeResultCommands } from "./commands/large-result";
import { registerLinearCommands } from "./commands/linear";
import { registerMcpServerCommands } from "./commands/mcp-server";
import { registerMemberCommands } from "./commands/member";
import { registerMemoryCommands } from "./commands/memory";
import { registerModelCommands } from "./commands/model";
import { registerOrgCommands } from "./commands/org";
import {
  registerEventCommands,
  registerParticipantCommands,
} from "./commands/platform-log";
import { registerProjectCommands } from "./commands/project";
import { registerPromptCommands } from "./commands/prompt";
import { registerPylonCommands } from "./commands/pylon";
import { registerRepoCommands } from "./commands/repo";
import { registerSandboxCommands } from "./commands/sandbox";
import { registerSkillCommands } from "./commands/skill";
import { registerSlackCommands } from "./commands/slack";
import { registerTagCommands } from "./commands/tag";
import { registerUpgradeCommand } from "./commands/upgrade";
import { banner } from "./output/theme";

/** Global options that take a value, for finding the command word in raw argv. */
export const VALUE_OPTIONS = ["--url", "--org", "--project"];

/**
 * Build the `hypotenuse` command tree.
 * @returns The configured commander program, not yet parsed.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("hypotenuse")
    .description(pkg.description)
    .version(pkg.version, "-v, --version", "print the CLI version")
    .option(
      "--url <origin>",
      "the Hypotenuse server (default: where you last logged in)",
    )
    .option(
      "--org <id|slug>",
      "the organization to act on (default: `org use`)",
    )
    .option(
      "--project <id|slug>",
      "the project to act on (default: `project use`)",
    )
    .option("-j, --json", "print machine-readable JSON on stdout")
    .option("--verbose", "print each request on stderr")
    .option("--no-color", "disable colored output")
    // Read by `output/early-env` before parsing; declared so commander accepts it.
    .option("--force-color", "color output even when it is piped")
    .showHelpAfterError()
    // Bare `hypotenuse` shows what it can do, rather than exiting silently.
    .action(() => {
      console.log(banner(pkg.version));
      console.log("");
      program.outputHelp();
    });

  registerAuthCommands(program);
  registerOrgCommands(program);
  registerProjectCommands(program);
  registerMemberCommands(program);
  registerInviteCommands(program);
  registerTagCommands(program);
  registerModelCommands(program);
  registerBotCommands(program);
  registerMcpServerCommands(program);
  registerPromptCommands(program);
  registerGoalCommands(program);
  registerSkillCommands(program);
  registerInstallationCommands(program);
  registerSlackCommands(program);
  registerLinearCommands(program);
  registerPylonCommands(program);
  registerChannelCommands(program);
  registerBindingCommands(program);
  registerConversationCommands(program);
  registerApprovalCommands(program);
  registerHelpRequestCommands(program);
  registerLargeResultCommands(program);
  registerCodeRunCommands(program);
  registerSandboxCommands(program);
  registerRepoCommands(program);
  registerMemoryCommands(program);
  registerParticipantCommands(program);
  registerEventCommands(program);
  registerAuditCommands(program);
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
