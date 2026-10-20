import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Run the CLI from source as a user would.
 * @param args - Arguments after `hypotenuse`.
 * @param env - Environment overrides on top of this process's.
 * @returns Exit code and captured output.
 */
async function run(
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("hypotenuse CLI", () => {
  test("--version prints the package version", async () => {
    const { code, stdout } = await run(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test("--help names the program", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: hypotenuse");
  });

  test("--force-color is accepted and colors piped output", async () => {
    const { code, stdout, stderr } = await run(["--force-color"], {
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("\x1b[");
  });

  test("--no-color beats an inherited FORCE_COLOR", async () => {
    const { code, stdout } = await run(["--no-color"], { FORCE_COLOR: "1" });
    expect(code).toBe(0);
    expect(stdout).not.toContain("\x1b[");
    expect(stdout).toContain(pkg.version);
  });
});
