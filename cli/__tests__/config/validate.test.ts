import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../../src/config/loader";
import type { MachineEnv, RunResult } from "../../src/config/machine";
import type { Config } from "../../src/config/schema";
import { suggest } from "../../src/config/suggest";
import { validateMachine, validateReferences } from "../../src/config/validate";

/**
 * Every row of the pass-2 and pass-3 tables, each with a fixture and its exact
 * message. Pass 3 runs against a scripted machine, so the tests say what the
 * machine has instead of needing one.
 */

const env = { HOME: "/home/mario", PATH: "/usr/bin", SET_ME: "yes" };
const ctx = {
  baseDir: "/home/mario/.config/hypotenuse",
  env,
  cpuCount: 12,
  hostname: "mbp",
};

/**
 * Parse a config that must pass the schema.
 * @param text - The TOML.
 * @returns The config.
 */
function config(text: string): Config {
  const result = parseConfigText(
    `config_version = 1\n${text}`,
    `${ctx.baseDir}/config.toml`,
    ctx,
  );
  if (!result.config) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

/** A clone on the scripted machine. */
interface Clone {
  origin?: string;
  head?: string;
  heads?: string[];
  worktreeOf?: string;
}

/**
 * A scripted machine.
 * @param spec - What it has.
 * @returns The machine.
 */
function machine(
  spec: {
    git?: string;
    bins?: string[];
    clones?: Record<string, Clone>;
    dirs?: string[];
    files?: Record<string, string>;
    readOnly?: string[];
  } = {},
): MachineEnv {
  const clones = spec.clones ?? {};
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const fail = (): RunResult => ({ code: 1, stdout: "", stderr: "fatal" });
  return {
    env,
    which: (cmd) =>
      (spec.bins ?? ["npx", "bun"]).includes(cmd) ? `/usr/bin/${cmd}` : null,
    git: (args, cwd) => {
      if (args[0] === "--version")
        return ok(`git version ${spec.git ?? "2.43.0"}\n`);
      const clone = cwd ? clones[cwd] : undefined;
      if (!clone) return fail();
      if (args.join(" ") === "rev-parse --git-dir")
        return ok(
          clone.worktreeOf ? `${clone.worktreeOf}/.git/worktrees/x` : ".git",
        );
      if (args.join(" ") === "rev-parse --git-common-dir")
        return ok(clone.worktreeOf ? `${clone.worktreeOf}/.git` : ".git");
      if (args.join(" ") === "config --get remote.origin.url")
        return clone.origin ? ok(`${clone.origin}\n`) : fail();
      if (args[0] === "symbolic-ref")
        return clone.head ? ok(`origin/${clone.head}\n`) : fail();
      if (args[0] === "ls-remote") {
        const branch = args.at(-1) as string;
        return ok(
          (clone.heads ?? ["main"]).includes(branch)
            ? `abc\trefs/heads/${branch}\n`
            : "",
        );
      }
      return fail();
    },
    exists: (p) =>
      p in clones || (spec.dirs ?? []).includes(p) || p in (spec.files ?? {}),
    isDirectory: (p) => p in clones || (spec.dirs ?? []).includes(p),
    isWritable: (p) => !(spec.readOnly ?? []).some((r) => p.startsWith(r)),
    readFile: (p) => spec.files?.[p] ?? null,
  };
}

const worker = '[roles.worker]\nagent = "claude"\n';

describe("pass 2 — references", () => {
  test("a role's agent names a defined agent or a preset, with a near name suggested", () => {
    const c = config(
      '[roles.worker]\nagent = "codx"\n[agents.codex]\npreset = "codex"\n',
    );
    expect(validateReferences(c).errors).toEqual([
      {
        path: "roles.worker.agent",
        message: 'unknown agent "codx" (did you mean "codex"?)',
      },
    ]);
    expect(validateReferences(config(worker)).errors).toEqual([]);
  });

  test("runner.roles names only roles with a [roles.*] table", () => {
    const c = config(`[runner]\nroles = ["worker", "manager"]\n${worker}`);
    expect(validateReferences(c).errors).toEqual([
      {
        path: "runner.roles[1]",
        message: '"manager" has no [roles.manager] table',
      },
    ]);
  });

  test("prompt and prompt_file are not both set", () => {
    const c = config(
      '[runner]\nroles = ["manager"]\n[roles.manager]\nagent = "claude"\nprompt = "x"\nprompt_file = "p.md"\n',
    );
    expect(validateReferences(c).errors).toEqual([
      { path: "roles.manager", message: "set prompt or prompt_file, not both" },
    ]);
  });

  test("an agent has exactly one of preset and command", () => {
    const neither = config(`${worker}[agents.local]\nargs = ["--x"]\n`);
    expect(validateReferences(neither).errors).toEqual([
      {
        path: "agents.local",
        message: "set preset or command",
        hint: "presets: claude, codex, gemini, copilot, goose, opencode, cursor, qwen, cline, auggie, kilo",
      },
    ]);
    const both = config(
      `${worker}[agents.local]\npreset = "goose"\ncommand = ["goose"]\n`,
    );
    expect(validateReferences(both).errors).toEqual([
      { path: "agents.local", message: "set preset or command, not both" },
    ]);
  });

  test("repository names are unique", () => {
    const c = config(
      `${worker}[[repositories]]\npath = "~/a"\n[[repositories]]\npath = "~/b"\nname = "api"\n[[repositories]]\npath = "~/d"\nname = "api"\n`,
    );
    expect(validateReferences(c).errors).toEqual([
      {
        path: "repositories[2].name",
        message: '"api" is already repositories[1]',
      },
    ]);
  });

  test("a name derived from a path must be one the server accepts", () => {
    const c = config(`${worker}[[repositories]]\npath = "~/My Code"\n`);
    expect(validateReferences(c).errors).toEqual([
      {
        path: "repositories[0]",
        message:
          '"My Code" is not a usable repository name (letters, digits, `.`, `_`, `-`); set name',
      },
    ]);
  });

  test("keepalive_interval stays under Linear's 30-minute stale window", () => {
    const c = config(
      `${worker}[sessions]\nkeepalive_interval = "45m"\nidle_timeout = "50m"\nturn_timeout = "60m"\n`,
    );
    expect(validateReferences(c).errors).toEqual([
      {
        path: "sessions.keepalive_interval",
        message: "45m is longer than Linear's 30m stale window",
      },
    ]);
  });

  test("idle_timeout ≥ keepalive_interval and turn_timeout ≥ idle_timeout", () => {
    const c = config(
      `${worker}[sessions]\nkeepalive_interval = "10m"\nidle_timeout = "5m"\nturn_timeout = "4m"\n`,
    );
    expect(validateReferences(c).errors).toEqual([
      {
        path: "sessions.idle_timeout",
        message: "5m is shorter than keepalive_interval (10m)",
      },
      {
        path: "sessions.turn_timeout",
        message: "4m is shorter than idle_timeout (5m)",
      },
    ]);
    const role = config(
      '[roles.worker]\nagent = "claude"\nturn_timeout = "5m"\n',
    );
    expect(validateReferences(role).errors).toEqual([
      {
        path: "roles.worker.turn_timeout",
        message: "5m is shorter than sessions.idle_timeout (15m)",
      },
    ]);
  });

  test('cleanup = "ttl" requires cleanup_ttl', () => {
    const c = config(`${worker}[sessions]\ncleanup = "ttl"\n`);
    expect(validateReferences(c).errors).toEqual([
      {
        path: "sessions.cleanup_ttl",
        message: 'required when cleanup = "ttl"',
      },
    ]);
    expect(
      validateReferences(
        config(`${worker}[sessions]\ncleanup = "ttl"\ncleanup_ttl = "7d"\n`),
      ).errors,
    ).toEqual([]);
  });

  test("a max_parallel at or above the machine cap is a warning", () => {
    const c = config(
      `[runner]\nmax_parallel_jobs = 3\n[roles.worker]\nagent = "claude"\nmax_parallel = 3\n[agents.claude]\npreset = "claude"\nmax_parallel = 4\n`,
    );
    expect(validateReferences(c).warnings).toEqual([
      {
        path: "agents.claude.max_parallel",
        message:
          "4 is not below runner.max_parallel_jobs (3); it has no effect",
      },
      {
        path: "roles.worker.max_parallel",
        message:
          "3 is not below runner.max_parallel_jobs (3); it has no effect",
      },
    ]);
  });

  test("a manager that may write or run commands is a warning; the read-only default is not", () => {
    const roles = (policy: string) =>
      config(
        `[runner]\nroles = ["manager"]\n[roles.manager]\nagent = "claude"\n${policy}`,
      );
    const warning = {
      path: "roles.manager.permission_policy",
      message:
        "a manager with write permission can change code; this is allowed but unusual",
      hint: 'the default denies edit, delete, move, and execute: { default = "allow", edit = "deny", delete = "deny", move = "deny", execute = "deny" }',
    };
    expect(validateReferences(roles("")).warnings).toEqual([]);
    expect(
      validateReferences(roles('permission_policy = "deny"')).warnings,
    ).toEqual([]);
    expect(
      validateReferences(roles('permission_policy = "ask"')).warnings,
    ).toEqual([warning]);
    expect(
      validateReferences(
        roles('permission_policy = { default = "allow", edit = "deny" }'),
      ).warnings,
    ).toEqual([warning]);
  });

  test("an inline prompt's variables are known", () => {
    const c = config(
      '[roles.worker]\nagent = "claude"\nprompt = "Fix {{issue.titel}} on {{ runner.name }}"\n',
    );
    expect(validateReferences(c).errors).toEqual([
      {
        path: "roles.worker.prompt",
        message:
          "unknown variable {{issue.titel}} (did you mean {{issue.title}}?)",
      },
    ]);
  });

  test("extra MCP servers: one transport, unique names, hypotenuse reserved, Linear's own warned", () => {
    const c = config(
      `${worker}[[roles.worker.extra_mcp_servers]]\nname = "hypotenuse"\ncommand = ["x"]\n[[roles.worker.extra_mcp_servers]]\nname = "s"\n[[roles.worker.extra_mcp_servers]]\nname = "s"\nurl = "https://mcp.linear.app/sse"\n`,
    );
    const { errors, warnings } = validateReferences(c);
    expect(errors).toEqual([
      {
        path: "roles.worker.extra_mcp_servers[0].name",
        message: '"hypotenuse" is reserved for the built-in server',
      },
      {
        path: "roles.worker.extra_mcp_servers[1]",
        message: "set command or url, not both or neither",
      },
      {
        path: "roles.worker.extra_mcp_servers[2].name",
        message: '"s" is already used in this role',
      },
    ]);
    expect(warnings.map((w) => w.path)).toEqual([
      "roles.worker.extra_mcp_servers[2].url",
    ]);
  });
});

describe("pass 3 — this machine", () => {
  const web = "/home/mario/code/web";
  const good = {
    [web]: {
      origin: "git@github.com:acme/web.git",
      head: "main",
      heads: ["main"],
    },
  };

  test("a valid machine has nothing to say", () => {
    const c = config(`${worker}[[repositories]]\npath = "~/code/web"\n`);
    expect(validateMachine(c, machine({ clones: good }))).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("a repository path exists and is a git clone, not a worktree", () => {
    const c = config(
      `${worker}[[repositories]]\npath = "~/code/web"\n[[repositories]]\npath = "~/code/old"\n[[repositories]]\npath = "~/code/wt"\n`,
    );
    const m = machine({
      clones: {
        ...good,
        "/home/mario/code/wt": {
          worktreeOf: web,
          origin: "github.com/acme/wt",
        },
      },
      dirs: ["/home/mario/code/old"],
    });
    expect(validateMachine(c, m).errors).toEqual([
      {
        path: "repositories[1].path",
        message: "~/code/old is not a git repository",
      },
      {
        path: "repositories[2].path",
        message: "~/code/wt is a worktree; point at the clone it belongs to",
      },
    ]);
    const missing = config(`${worker}[[repositories]]\npath = "~/code/gone"\n`);
    expect(validateMachine(missing, machine()).errors).toEqual([
      { path: "repositories[0].path", message: "~/code/gone does not exist" },
    ]);
  });

  test("a clone with no origin has no remote, which is an error", () => {
    const none = machine({ clones: { [web]: {} } });
    expect(
      validateMachine(
        config(`${worker}[[repositories]]\npath = "~/code/web"\n`),
        none,
      ).errors,
    ).toEqual([
      {
        path: "repositories[0].path",
        message: "~/code/web has no origin remote",
      },
    ]);
  });

  test("two clones of one origin are one repository too many", () => {
    const c = config(
      `${worker}[[repositories]]\npath = "~/code/web"\n[[repositories]]\npath = "~/code/web2"\n`,
    );
    const m = machine({
      clones: {
        ...good,
        "/home/mario/code/web2": {
          origin: "https://github.com/acme/web.git",
          head: "main",
          heads: ["main"],
        },
      },
    });
    expect(validateMachine(c, m).errors).toEqual([
      {
        path: "repositories[1].path",
        message:
          "~/code/web2 is another clone of github.com/acme/web, already repositories[0]",
      },
    ]);
  });

  test("base_branch missing on origin is a warning, skipped offline", () => {
    const c = config(
      `${worker}[[repositories]]\npath = "~/code/web"\nbase_branch = "trunk"\n`,
    );
    expect(validateMachine(c, machine({ clones: good })).warnings).toEqual([
      {
        path: "repositories[0].base_branch",
        message: '"trunk" not found on origin (github.com/acme/web)',
      },
    ]);
    expect(
      validateMachine(c, machine({ clones: good }), { offline: true }).warnings,
    ).toEqual([]);
  });

  test("a prompt_file is readable and uses only known variables", () => {
    const c = config(
      '[roles.worker]\nagent = "claude"\nprompt_file = "prompts/worker.md"\n',
    );
    const path = "/home/mario/.config/hypotenuse/prompts/worker.md";
    expect(validateMachine(c, machine()).errors).toEqual([
      {
        path: "roles.worker.prompt_file",
        message: "~/.config/hypotenuse/prompts/worker.md cannot be read",
      },
    ]);
    expect(
      validateMachine(c, machine({ files: { [path]: "Fix {{issue.titel}}" } }))
        .errors,
    ).toEqual([
      {
        path: "roles.worker.prompt_file",
        message:
          "unknown variable {{issue.titel}} (did you mean {{issue.title}}?)",
      },
    ]);
    expect(
      validateMachine(
        c,
        machine({
          files: { [path]: "Fix {{issue.title}} in {{worktree.path}}" },
        }),
      ).errors,
    ).toEqual([]);
  });

  test("each used agent's command resolves on PATH", () => {
    const c = config(
      '[roles.worker]\nagent = "goose"\n[agents.local]\ncommand = ["my-agent", "--acp"]\n[runner]\nroles = ["worker", "manager"]\n[roles.manager]\nagent = "local"\n',
    );
    expect(validateMachine(c, machine({ bins: [] })).errors).toEqual([
      { path: "agents.local.command", message: '"my-agent" not found on PATH' },
      {
        path: "roles.worker.agent",
        message: '"goose" not found on PATH (the goose preset runs it)',
      },
    ]);
  });

  test("worktree_root is writable and not inside a configured repository", () => {
    const c = config(
      `${worker}[[repositories]]\npath = "~/code/web"\n[sessions]\nworktree_root = "~/code/web/.trees"\n`,
    );
    expect(validateMachine(c, machine({ clones: good })).errors).toEqual([
      {
        path: "sessions.worktree_root",
        message: "~/code/web/.trees is inside repositories[0] (~/code/web)",
      },
    ]);
    const ro = config(`${worker}[sessions]\nworktree_root = "/opt/trees"\n`);
    expect(validateMachine(ro, machine({ readOnly: ["/opt"] })).errors).toEqual(
      [
        {
          path: "sessions.worktree_root",
          message: "/opt/trees is not writable",
        },
      ],
    );
  });

  test("git is at least 2.38", () => {
    expect(
      validateMachine(config(worker), machine({ git: "2.37.1" })).errors,
    ).toEqual([{ path: "git", message: "git 2.37.1 is older than 2.38" }]);
    expect(
      validateMachine(
        config(worker),
        machine({ git: "2.39.3 (Apple Git-146)" }),
      ).errors,
    ).toEqual([]);
  });

  test("an unset $VAR in an agent's or MCP server's env is a warning", () => {
    const c = config(
      `${worker}[agents.claude]\npreset = "claude"\nenv = { A = "$SET_ME", B = "$NOT_SET" }\n[[roles.worker.extra_mcp_servers]]\nname = "sentry"\ncommand = ["npx"]\nenv = { SENTRY_AUTH_TOKEN = "\${SENTRY_AUTH_TOKEN}" }\n`,
    );
    expect(validateMachine(c, machine()).warnings).toEqual([
      {
        path: "roles.worker.extra_mcp_servers[0].env.SENTRY_AUTH_TOKEN",
        message: "$SENTRY_AUTH_TOKEN is not set in this environment",
      },
      {
        path: "agents.claude.env.B",
        message: "$NOT_SET is not set in this environment",
      },
    ]);
  });
});

describe("did you mean", () => {
  test("within two edits, transpositions counted once", () => {
    expect(suggest("codx", ["claude", "codex"])).toBe("codex");
    expect(suggest("cluade", ["claude", "codex"])).toBe("claude");
    expect(suggest("something", ["claude", "codex"])).toBeUndefined();
  });
});
