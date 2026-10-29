import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { buildProgram } from "../src/program";

const SKILL = readFileSync(
  join(import.meta.dir, "..", "skills", "hypotenuse.md"),
  "utf8",
);

const DOCS = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "frontend",
    "src",
    "content",
    "docs",
    "cli.md",
  ),
  "utf8",
);

/**
 * Every command with subcommands, nested ones included, with its path.
 * @param program - The root program.
 * @returns `{ path: "model connection", command }` for each group.
 */
function groups(program: Command): { path: string; command: Command }[] {
  const found: { path: string; command: Command }[] = [];
  /**
   * Collect a command's groups beneath a path.
   * @param command - The command.
   * @param prefix - Its parents' names.
   */
  const walk = (command: Command, prefix: string) => {
    for (const sub of command.commands) {
      if (sub.commands.length === 0) continue;
      const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
      found.push({ path, command: sub });
      walk(sub, path);
    }
  };
  walk(program, "");
  return found;
}

describe("skills/hypotenuse.md tracks --help", () => {
  const program = buildProgram();

  test("every top-level command appears", () => {
    const missing = program.commands
      .map((c) => c.name())
      .filter((name) => !SKILL.includes(`hypotenuse ${name}`));
    expect(missing).toEqual([]);
  });

  test("every subcommand appears on its group's rows", () => {
    const rows = SKILL.split("\n").filter((line) => line.startsWith("|"));
    const missing: string[] = [];
    for (const { path, command } of groups(program)) {
      // A top-level command may take several rows (`model connection …`,
      // `model alias …`), and a nested group is described on its parent's.
      const top = path.split(" ")[0];
      const own = rows.filter((line) => line.includes(`\`hypotenuse ${top} `));
      for (const sub of command.commands) {
        if (!own.some((line) => line.includes(sub.name()))) {
          missing.push(`${path} ${sub.name()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("the /docs/cli page tracks --help", () => {
  test("every command and subcommand is named", () => {
    const missing: string[] = [];
    for (const group of buildProgram().commands) {
      if (!DOCS.includes(`hypotenuse ${group.name()}`)) {
        missing.push(group.name());
      }
    }
    for (const { path, command } of groups(buildProgram())) {
      for (const sub of command.commands) {
        if (!DOCS.includes(`${path} ${sub.name()}`)) {
          missing.push(`${path} ${sub.name()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
