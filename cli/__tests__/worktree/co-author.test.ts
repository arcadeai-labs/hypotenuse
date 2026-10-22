import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coAuthorEnvironment,
  GIT_HOOK_NAMES,
  installCoAuthorHooks,
} from "../../src/worktree/co-author";

// Real git, in a real repository and a linked worktree, with the environment
// the agent host gives a coding agent.

const CO_AUTHOR = "Hypotenuse <noreply@hypotenuse.cloud>";
const TRAILER = `Co-Authored-By: ${CO_AUTHOR}`;

let root: string;
let repo: string;
let worktree: string;
let hooksDir: string;

/** The person's environment: an identity, and nothing of ours. */
const person: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: "Mario",
  GIT_AUTHOR_EMAIL: "mario@example.com",
  GIT_COMMITTER_NAME: "Mario",
  GIT_COMMITTER_EMAIL: "mario@example.com",
};
delete person.GIT_CONFIG_COUNT;

/**
 * The agent's environment: the person's plus the co-author variables.
 * @param base - The environment before them.
 * @returns The agent's.
 */
function agentEnv(base: Record<string, string> = person) {
  return { ...base, ...coAuthorEnvironment(base, hooksDir, CO_AUTHOR) };
}

/**
 * Run git.
 * @param cwd - Where.
 * @param env - With which environment.
 * @param args - Arguments.
 * @returns Exit code and output.
 */
function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString().trim(),
    err: run.stderr.toString(),
  };
}

/**
 * Commit an empty change.
 * @param env - With which environment.
 * @param message - The message.
 * @returns The commit's exit code and its message (the last commit's).
 */
function commit(env: Record<string, string>, message: string) {
  const { code, err } = git(
    worktree,
    env,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
  return {
    code,
    err,
    body: git(worktree, env, "log", "-1", "--format=%B").out,
  };
}

/**
 * Write an executable hook.
 * @param dir - The hooks directory.
 * @param name - The hook.
 * @param body - Shell after the shebang.
 */
function hook(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hyp-co-author-"));
  repo = join(root, "web");
  worktree = join(root, "wt");
  mkdirSync(repo);
  git(repo, person, "init", "-q", "-b", "main");
  git(repo, person, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, person, "worktree", "add", "-q", worktree, "-b", "agent");
  hooksDir = installCoAuthorHooks(join(root, "state"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the co-author trailer", () => {
  test("is added to the agent's commits and not to the person's", () => {
    const agent = commit(agentEnv(), "Fix rounding");
    expect(agent.code).toBe(0);
    expect(agent.body).toBe(`Fix rounding\n\n${TRAILER}`);
    expect(git(worktree, person, "log", "-1", "--format=%an").out).toBe(
      "Mario",
    );

    const own = commit(person, "By hand");
    expect(own.body).toBe("By hand");
    expect(git(repo, person, "config", "--get", "core.hooksPath").code).toBe(1);
  });

  test("is not repeated when the agent wrote it already", () => {
    const { body } = commit(agentEnv(), `Tidy\n\n${TRAILER}`);
    expect(body).toBe(`Tidy\n\n${TRAILER}`);
  });

  test("runs the repository's own hooks, which can still refuse", () => {
    const own = join(repo, ".git", "hooks");
    try {
      hook(
        own,
        "commit-msg",
        'git interpret-trailers --in-place --trailer "Reviewed-by: lint" "$1"',
      );
      hook(own, "pre-commit", `touch "${join(root, "pre-commit-ran")}"`);
      const ok = commit(agentEnv(), "Checked");
      expect(ok.body).toBe(`Checked\n\nReviewed-by: lint\n${TRAILER}`);
      expect(existsSync(join(root, "pre-commit-ran"))).toBe(true);

      hook(own, "commit-msg", 'echo "no WIP" >&2; exit 1');
      const refused = commit(agentEnv(), "WIP");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("no WIP");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  test("honors a relative core.hooksPath, as husky sets", () => {
    git(repo, person, "config", "core.hooksPath", ".husky/_");
    try {
      hook(
        join(worktree, ".husky", "_"),
        "pre-commit",
        'echo "lint failed" >&2; exit 1',
      );
      const refused = commit(agentEnv(), "Lint me");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("lint failed");
    } finally {
      git(repo, person, "config", "--unset", "core.hooksPath");
    }
  });

  test("keeps config entries the environment already carries", () => {
    const base = {
      ...person,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    };
    const env = agentEnv(base);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(
      git(worktree, env, "config", "--get", "user.useConfigOnly").out,
    ).toBe("true");
    expect(commit(env, "Both").body).toBe(`Both\n\n${TRAILER}`);
  });

  test("shims every hook name as an executable", () => {
    for (const name of GIT_HOOK_NAMES) {
      const run = Bun.spawnSync(["test", "-x", join(hooksDir, name)]);
      expect({ name, executable: run.exitCode === 0 }).toEqual({
        name,
        executable: true,
      });
    }
  });
});
