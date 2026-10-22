import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatSize,
  parseDuration,
  parseSize,
} from "../../src/config/durations";
import { parseConfigText, renderIssuePath } from "../../src/config/loader";
import { expandPath } from "../../src/config/paths";
import {
  buildConfigSchema,
  CONFIG_SCHEMA_ID,
  configJsonSchema,
  defaultMaxParallelJobs,
} from "../../src/config/schema";

const ctx = {
  baseDir: "/etc/hyp",
  env: { HOME: "/home/mario", CODE: "/src" },
  cpuCount: 16,
  hostname: "mbp.local",
};

/**
 * Parse TOML text with the test context.
 * @param text - The file.
 * @returns The load result.
 */
function parse(text: string) {
  return parseConfigText(text, "/etc/hyp/config.toml", ctx);
}

const minimal = 'config_version = 1\n[roles.worker]\nagent = "claude"\n';

describe("durations and sizes", () => {
  test("parse with a unit and print back in the same spelling", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(() => parseDuration("10")).toThrow('"10" is not a duration');
    expect(formatDuration(2_700_000)).toBe("45m");
    expect(formatDuration(90_000)).toBe("90s");
    expect(parseSize("500MB")).toBe(500 * 1024 ** 2);
    expect(parseSize("2GB")).toBe(2 * 1024 ** 3);
    expect(formatSize(2 * 1024 ** 3)).toBe("2GB");
    expect(() => parseSize("2 parsecs")).toThrow("is not a size");
  });
});

describe("paths", () => {
  test("~ and $VAR expand; relative paths resolve against the config's directory", () => {
    expect(expandPath("~/code/web", "/etc/hyp", ctx.env)).toBe(
      "/home/mario/code/web",
    );
    expect(expandPath("$CODE/api", "/etc/hyp", ctx.env)).toBe("/src/api");
    expect(expandPath("${CODE}/api", "/etc/hyp", ctx.env)).toBe("/src/api");
    expect(expandPath("prompts/worker.md", "/etc/hyp", ctx.env)).toBe(
      "/etc/hyp/prompts/worker.md",
    );
  });
});

describe("the schema", () => {
  test("every key's default", () => {
    const { config, issues } = parse(minimal);
    expect(issues).toEqual([]);
    expect(config).toEqual({
      config_version: 1,
      server: {},
      runner: { name: "mbp", max_parallel_jobs: 4, roles: ["worker"] },
      subscriptions: { teams: [], projects: [], labels: [] },
      agents: {},
      roles: {
        worker: {
          agent: "claude",
          permission_policy: "allow",
          additional_directories: [],
          extra_mcp_servers: [],
        },
      },
      repositories: [],
      sessions: {
        worktrees: "always",
        worktree_root: "/home/mario/.hypotenuse/worktrees",
        cleanup: "on-complete",
        cleanup_grace: 3_600_000,
        turn_timeout: 3_600_000,
        idle_timeout: 900_000,
        keepalive_interval: 600_000,
        stop_grace: 10_000,
        min_free_disk: 2 * 1024 ** 3,
      },
      log: { level: "info" },
    });
  });

  test("table defaults inside agents, roles, and repositories", () => {
    const { config } = parse(
      `${minimal}[roles.manager]\nagent = "claude"\n[agents.claude]\npreset = "claude"\n[[repositories]]\npath = "~/web"\n`,
    );
    expect(config?.roles.manager?.permission_policy).toEqual({
      default: "allow",
      edit: "deny",
      delete: "deny",
      move: "deny",
      execute: "deny",
    });
    expect(config?.agents.claude).toEqual({
      preset: "claude",
      args: [],
      env: {},
      startup_timeout: 60_000,
    });
    expect(config?.repositories[0]).toEqual({
      path: "/home/mario/web",
      setup: [],
      setup_timeout: 600_000,
      branch_prefix: "hypotenuse",
      pr_url_patterns: [],
    });
  });

  test("max_parallel_jobs defaults to a quarter of the cores, 1 to 8", () => {
    expect([1, 4, 7, 8, 16, 64].map(defaultMaxParallelJobs)).toEqual([
      1, 1, 1, 2, 4, 8,
    ]);
  });

  test("an unknown key is an error at its path, with a near name suggested", () => {
    const { config, issues } = parse(
      `${minimal}[runner]\nmax_paralel_jobs = 3\n`,
    );
    expect(config).toBeNull();
    expect(issues).toEqual([
      {
        path: "runner.max_paralel_jobs",
        message: 'unknown key (did you mean "max_parallel_jobs"?)',
      },
    ]);
  });

  test("paths render the TOML way", () => {
    expect(renderIssuePath(["repositories", 1, "base_branch"])).toBe(
      "repositories[1].base_branch",
    );
    expect(renderIssuePath(["agents", "codex", "command"])).toBe(
      "agents.codex.command",
    );
    const { issues } = parse(
      `${minimal}[[repositories]]\npath = "a"\n[[repositories]]\npath = "b"\nsetup_timeout = "soon"\n`,
    );
    expect(issues).toEqual([
      {
        path: "repositories[1].setup_timeout",
        message: "expected a duration such as 45s, 10m, 2h, or 7d",
      },
    ]);
  });

  test("an enum suggests the value it was near", () => {
    const { issues } = parse(`${minimal}[sessions]\ncleanup = "on-compete"\n`);
    expect(issues[0]?.path).toBe("sessions.cleanup");
    expect(issues[0]?.message).toContain('(did you mean "on-complete"?)');
  });

  test("config_version is required and must be 1", () => {
    expect(parse('[roles.worker]\nagent = "claude"\n').issues).toEqual([
      {
        path: "config_version",
        message: "required: this build reads config_version = 1",
      },
    ]);
    const future = parse("config_version = 2\n");
    expect(future.issues[0]?.message).toBe(
      "2 is not a config version this build reads (it reads 1)",
    );
    expect(future.issues[0]?.hint).toBe("run `hypotenuse upgrade`");
  });

  test("a TOML syntax error carries its line and column and makes the file unreadable", () => {
    const result = parse("config_version = 1\n[x]\n  b c = 2\n");
    expect(result.unreadable).toBe(true);
    expect(result.issues).toEqual([
      { path: "", message: "illegal character in key", line: 3, column: 5 },
    ]);
  });

  test("the JSON Schema has its $id, and objects refuse extra keys", () => {
    const schema = configJsonSchema() as {
      $id: string;
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.$id).toBe(CONFIG_SCHEMA_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "agents",
        "config_version",
        "log",
        "repositories",
        "roles",
        "runner",
        "server",
        "sessions",
        "subscriptions",
      ].sort(),
    );
  });

  test("one schema per file: relative paths follow the file", () => {
    const a = buildConfigSchema({ ...ctx, baseDir: "/a" }).parse({
      config_version: 1,
      log: { file: "d.log" },
    });
    const b = buildConfigSchema({ ...ctx, baseDir: "/b" }).parse({
      config_version: 1,
      log: { file: "d.log" },
    });
    expect([a.log.file, b.log.file]).toEqual(["/a/d.log", "/b/d.log"]);
  });
});
