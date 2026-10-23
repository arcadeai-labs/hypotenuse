/**
 * `hypotenuse skill` — print the agent skill that teaches a coding agent to
 * drive this CLI. The skill stays its own file, `skills/hypotenuse.md`: the npm
 * package ships it beside the bundle, and the compiled binary embeds it at
 * build time (`build` passes it to `bun build --compile`), so every install
 * prints the same text without the code importing it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { emit, runCommand } from "../context";

/** The skill's file name, in `skills/` and among a binary's embedded files. */
const SKILL_FILE = "hypotenuse.md";

/**
 * Read the skill: the copy embedded in a compiled binary, else the file in the
 * package (`dist/../skills` for the npm bundle, `src/commands/../../skills`
 * from source).
 * @returns The skill's text.
 * @throws {Error} When neither is there — a broken install.
 */
export async function readSkill(): Promise<string> {
  const embedded = Bun.embeddedFiles.find(
    (file) => (file as Blob & { name?: string }).name === SKILL_FILE,
  );
  if (embedded) return embedded.text();
  for (const up of [[".."], ["..", ".."]]) {
    const path = join(import.meta.dir, ...up, "skills", SKILL_FILE);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(
    `This install has no skills/${SKILL_FILE}; reinstall hypotenuse.`,
  );
}

/**
 * Register `skill`.
 * @param program - The root program.
 */
export function registerSkillCommand(program: Command): void {
  program
    .command("skill")
    .description(
      "Print the agent skill for using this CLI (save it as SKILL.md)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const skill = await readSkill();
        emit(ctx, { skill }, () => skill.trimEnd());
      });
    });
}
