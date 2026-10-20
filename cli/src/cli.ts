#!/usr/bin/env bun
// Must stay the first import: it turns color flags into env before anything renders.
import "./output/early-env";
import { Command } from "commander";
import pkg from "../package.json";
import { banner } from "./output/theme";

/**
 * Build the `hypotenuse` command-line program.
 * @returns The configured commander program, not yet parsed.
 */
export function buildProgram(): Command {
  return (
    new Command()
      .name("hypotenuse")
      .description(pkg.description)
      .version(pkg.version, "-V, --version", "print the version")
      .option("--no-color", "disable colored output")
      // Read by `output/early-env` before parsing; declared here so commander accepts it.
      .option("--force-color", "color output even when it is piped")
      .action(() => {
        console.log(banner(pkg.version));
      })
  );
}

if (import.meta.main) {
  await buildProgram().parseAsync(process.argv);
}
