import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const CLI_DIR = join(import.meta.dir, "..");
const SOURCE = join(CLI_DIR, "src", "cli.ts");

/**
 * Run a command and capture what it printed.
 * @param cmd - The argv to spawn.
 * @returns Exit code and captured output.
 */
async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    cwd: CLI_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("hypotenuse CLI from source", () => {
  test("--version prints the package version", async () => {
    const { code, stdout } = await run(["bun", "run", SOURCE, "--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test("--help names the program", async () => {
    const { code, stdout } = await run(["bun", "run", SOURCE, "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: hypotenuse");
  });
});

describe("hypotenuse CLI as a compiled binary", () => {
  // `bun build --compile` is how the CLI ships; a module that only works under
  // `bun run` would pass the suite above and fail here.
  const outDir = mkdtempSync(join(tmpdir(), "hypotenuse-cli-"));
  const binary = join(outDir, "hypotenuse");

  beforeAll(async () => {
    const { code, stderr } = await run([
      "bun",
      "build",
      "--compile",
      SOURCE,
      "--outfile",
      binary,
    ]);
    if (code !== 0) throw new Error(`bun build --compile failed: ${stderr}`);
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("--version prints the package version", async () => {
    const { code, stdout } = await run([binary, "--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });
});
