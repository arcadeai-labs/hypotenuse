import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("skills/hypotenuse.md tracks --help", () => {
  const program = buildProgram();

  test("every top-level command appears", () => {
    const missing = program.commands
      .map((c) => c.name())
      .filter((name) => !SKILL.includes(`hypotenuse ${name}`));
    expect(missing).toEqual([]);
  });

  test("every subcommand appears on its group's row", () => {
    const missing: string[] = [];
    for (const group of program.commands) {
      for (const sub of group.commands) {
        const row = SKILL.split("\n").find(
          (line) =>
            line.startsWith("|") &&
            line.includes(`\`hypotenuse ${group.name()} `),
        );
        if (!row?.includes(sub.name())) {
          missing.push(`${group.name()} ${sub.name()}`);
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
      for (const sub of group.commands) {
        if (!DOCS.includes(`${group.name()} ${sub.name()}`)) {
          missing.push(`${group.name()} ${sub.name()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
