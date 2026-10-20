#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json";

/**
 * Build the `hypotenuse` command-line program.
 * @returns The configured commander program, not yet parsed.
 */
export function buildProgram(): Command {
  return new Command()
    .name("hypotenuse")
    .description(pkg.description)
    .version(pkg.version, "-V, --version", "print the version");
}

if (import.meta.main) {
  await buildProgram().parseAsync(process.argv);
}
