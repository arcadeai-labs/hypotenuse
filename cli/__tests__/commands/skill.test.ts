import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `hypotenuse skill` prints the skill shipped in `skills/`, byte for byte. */
const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const SKILL = readFileSync(
  join(import.meta.dir, "..", "..", "skills", "hypotenuse.md"),
  "utf8",
);

/**
 * Run the CLI.
 * @param args - Its arguments.
 * @returns Code and output.
 */
async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HYPOTENUSE_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("hypotenuse skill", () => {
  test("prints the skill, frontmatter and all", async () => {
    const result = await run(["skill"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${SKILL.trimEnd()}\n`);
    expect(result.stdout.startsWith("---\nname: hypotenuse\n")).toBe(true);
  });

  test("both binary builds embed the file, the way readSkill looks for it", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string>; files: string[] };
    const release = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        ".github",
        "workflows",
        "auto-release.yml",
      ),
      "utf8",
    );
    for (const command of [pkg.scripts.build ?? "", release]) {
      expect(command).toContain("skills/hypotenuse.md");
      expect(command).toContain("--loader .md:file");
      expect(command).toContain("--asset-naming='[name].[ext]'");
    }
    // The npm bundle reads it from the package instead.
    expect(pkg.files).toContain("skills");
  });

  test("--json wraps it as { skill }", async () => {
    const result = await run(["--json", "skill"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ skill: SKILL });
  });
});
