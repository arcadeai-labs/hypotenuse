import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Run the CLI from source as a user would.
 * @param args - Arguments after `hypotenuse`.
 * @returns Exit code and captured output.
 */
async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
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
});
