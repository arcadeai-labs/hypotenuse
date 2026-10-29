#!/usr/bin/env bun
// Must stay the first import: it turns color flags into env before anything
// renders, and before ansis (upgradr's color library) decides at load time.
import "./output/early-env";
import { logger } from "./output/logger";
import { detectMode, setMode } from "./output/tty";
import { buildProgram, firstCommandWord } from "./program";
import { ExitError, installSignalHandlers } from "./shutdown";
import { updater } from "./update/updater";

installSignalHandlers();

// Resolve the output mode from raw argv before commander parses, so help and
// usage errors already obey --json / --no-color / NO_COLOR / FORCE_COLOR.
const argv = process.argv.slice(2);
setMode(
  detectMode({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY || process.stderr.isTTY),
    argv,
  }),
);

const program = buildProgram();

// An unknown command is named as such, rather than commander's "too many arguments".
const command = firstCommandWord(argv);
const known = new Set(program.commands.map((c) => c.name()));
if (command && command !== "help" && !known.has(command)) {
  logger.error(`unknown command '${command}'. See 'hypotenuse --help'.`);
  process.exit(1);
}

// Fire-and-forget; printed after the command's own output. Never under --json.
const json = argv.includes("--json") || argv.includes("-j");
const updateNotice = updater.maybeBackgroundNotice(
  json ? { isTTY: false } : undefined,
);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof ExitError) process.exit(error.code);
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

process.once("beforeExit", async () => {
  const notice = await updateNotice;
  if (notice) logger.writeRaw(notice);
});
