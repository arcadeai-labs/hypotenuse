import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_COMMANDS } from "../utils/install";

/** The repository's README, which documents the install commands. */
const README = readFileSync(
  join(import.meta.dir, "../../../README.md"),
  "utf8",
);

describe("install commands", () => {
  test("every command the dashboard shows is one the README documents", () => {
    const readmeLines = README.split("\n").map((l) => l.split("#")[0].trim());
    for (const { command } of INSTALL_COMMANDS) {
      expect(readmeLines).toContain(command);
    }
  });

  test("macOS/Linux, Windows, and the package manager are all offered", () => {
    expect(INSTALL_COMMANDS.map((i) => i.label)).toEqual([
      "macOS / Linux",
      "Windows (PowerShell)",
      "npm (requires Bun)",
    ]);
  });
});
