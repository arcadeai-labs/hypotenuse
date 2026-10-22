import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `hypotenuse config`, spawned from source on fixture files: `validate`'s
 * exit codes (0 valid, 1 errors, 2 unreadable) and its `--json` shape;
 * `init`'s detection and its refusal to overwrite; `schema` and `path`.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** A temporary home with a git clone at `~/code/web`. */
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "hypcfg-"));
  const repo = join(root, "code", "web");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(
    ["git", "remote", "add", "origin", "https://github.com/acme/web.git"],
    { cwd: repo },
  );
  return root;
}

/**
 * Run the CLI in a home.
 * @param root - The home.
 * @param args - Its arguments.
 * @returns Code and output.
 */
async function run(root: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, ".state"),
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_CONFIG: undefined,
      HYPOTENUSE_URL: undefined,
      NO_COLOR: "1",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("config validate", () => {
  test("exit 0 for a valid file, with warnings allowed", async () => {
    const root = home();
    const file = join(root, "ok.toml");
    writeFileSync(
      file,
      'config_version = 1\n[roles.worker]\nagent = "claude"\n[agents.claude]\ncommand = ["bun"]\nmax_parallel = 9\n',
    );
    const result = await run(root, [
      "-c",
      file,
      "config",
      "validate",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      path: file,
      errors: [],
      warnings: [
        {
          path: "agents.claude.max_parallel",
          message: expect.stringContaining(
            "is not below runner.max_parallel_jobs",
          ),
        },
      ],
    });
  });

  test("exit 1 with every error at its path", async () => {
    const root = home();
    const file = join(root, "bad.toml");
    writeFileSync(
      file,
      'config_version = 1\n[roles.worker]\nagent = "codx"\n[agents.codex]\npreset = "codex"\n',
    );
    const result = await run(root, ["-c", file, "config", "validate"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '✕ roles.worker.agent: unknown agent "codx" (did you mean "codex"?)',
    );
    expect(result.stdout).toContain("1 error, 0 warnings");
  });

  test("exit 2 for a file that cannot be parsed, with its line and column", async () => {
    const root = home();
    const file = join(root, "broken.toml");
    writeFileSync(file, "config_version = 1\n[x]\n  b c = 2\n");
    const result = await run(root, [
      "-c",
      file,
      "config",
      "validate",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).errors).toEqual([
      { path: "", message: "illegal character in key", line: 3, column: 5 },
    ]);
    const missing = await run(root, [
      "-c",
      join(root, "nope.toml"),
      "config",
      "validate",
    ]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain(
      "does not exist (run `hypotenuse config init`)",
    );
  });
});

describe("config init, schema, path", () => {
  test("init fills in a repository from its clone, validates, and refuses to overwrite", async () => {
    const root = home();
    const first = await run(root, [
      "config",
      "init",
      "--repo",
      join(root, "code", "web"),
    ]);
    expect(first.code).toBe(0);
    const text = readFileSync(
      join(root, ".config", "hypotenuse", "config.toml"),
      "utf8",
    );
    expect(
      text.startsWith(
        "#:schema https://www.hypotenuse.cloud/schemas/config-v1.json\n",
      ),
    ).toBe(true);
    expect(text).toContain(
      '[[repositories]]\nname = "web"\npath = "~/code/web"\nremote = "github.com/acme/web"\nbase_branch = "main"',
    );
    const parsed = Bun.TOML.parse(text) as {
      runner: { roles: string[] };
      roles: Record<string, { agent: string }>;
    };
    expect(parsed.runner.roles).toEqual(["manager", "worker"]);
    expect(Object.keys(parsed.roles).sort()).toEqual(["manager", "worker"]);
    expect(parsed.roles.manager.agent).toBe(parsed.roles.worker.agent);
    const again = await run(root, ["config", "init"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(
      "already exists; pass --force to overwrite it",
    );
  });

  test("schema prints JSON Schema; path prints the files in use", async () => {
    const root = home();
    const schema = await run(root, ["config", "schema"]);
    expect(JSON.parse(schema.stdout).$id).toBe(
      "https://www.hypotenuse.cloud/schemas/config-v1.json",
    );
    const path = await run(root, ["config", "path", "--json"]);
    expect(JSON.parse(path.stdout)).toEqual({
      config: join(root, ".config", "hypotenuse", "config.toml"),
      stateDir: join(root, ".state", "hypotenuse"),
      credentials: join(root, ".config", "hypotenuse", "credentials.json"),
    });
    const elsewhere = await run(root, [
      "-c",
      join(root, "proj", "hyp.toml"),
      "config",
      "path",
      "--json",
    ]);
    expect(JSON.parse(elsewhere.stdout).stateDir).toBe(
      join(root, "proj", ".hypotenuse-state"),
    );
  });
});

describe("doctor", () => {
  test("--agent runs the ACP initialize handshake and reports its auth methods", async () => {
    const root = home();
    const agent = join(import.meta.dir, "..", "fixtures", "fake-acp-agent.ts");
    const file = join(root, "doc.toml");
    writeFileSync(
      file,
      `config_version = 1\n[agents.fake]\ncommand = ["bun", "${agent}"]\nenv = { FAKE_ACP_AUTH_METHODS = "oauth,api-key" }\n[roles.worker]\nagent = "fake"\n[sessions]\nmin_free_disk = "1MB"\n`,
    );
    const result = await run(root, [
      "-c",
      file,
      "doctor",
      "--offline",
      "--agent",
      "fake",
      "--json",
    ]);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { group: string; status: string; message: string }[];
    };
    expect(report.checks).toContainEqual({
      group: "agents",
      status: "ok",
      message:
        "fake: fake-agent 1.2.3 answered initialize; auth methods: oauth, api-key; a session opened",
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({ group: "config", status: "ok" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ group: "disk", status: "ok" }),
    );
    // No credentials in this home: doctor fails, and says how to fix it.
    expect(result.code).toBe(1);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        group: "credentials",
        status: "fail",
        message: expect.stringContaining("hypotenuse login"),
      }),
    );
  }, 20_000);
});
