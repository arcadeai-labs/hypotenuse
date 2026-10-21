import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkAssignment } from "../../../protocol/src/index";
import type { ResolvedRepository } from "../../src/config/machine";
import type { Config } from "../../src/config/schema";
import type { EventInput } from "../../src/daemon/event-sink";
import { StateDb } from "../../src/daemon/state";
import {
  type AcquireRequest,
  type ManagerOptions,
  WorktreeManager,
} from "../../src/worktree/manager";
import { assignment, fakeConfig } from "../acp/harness";

/**
 * Real temporary git repositories for the worktree tests: a bare origin with
 * one commit on `main`, and a person's clone of it whose origin reads
 * `git@github.com:acme/web.git` (git's `insteadOf` sends it to the bare
 * directory), so remotes normalize to `github.com/acme/web` as in production.
 */

/** The remote every fixture clone reports. */
export const REMOTE = "github.com/acme/web";

/**
 * Run git, failing the test when it fails.
 * @param cwd - Where.
 * @param args - Arguments after `git`.
 * @returns Its stdout, trimmed.
 */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** One fixture: an origin, a clone, a config, and a manager. */
export interface Fixture {
  root: string;
  origin: string;
  clone: string;
  config: Config;
  repository: ResolvedRepository;
  state: StateDb;
  manager: WorktreeManager;
  events: EventInput[];
  log: string[];
}

/**
 * Point a clone's `git@github.com:acme/web.git` at a directory.
 * @param clone - The clone.
 * @param target - Where origin really is.
 */
export function routeOrigin(clone: string, target: string): void {
  const existing = Bun.spawnSync(
    ["git", "config", "--local", "--get-regexp", "^url\\..*\\.insteadof$"],
    { cwd: clone, stdout: "pipe" },
  )
    .stdout.toString()
    .trim();
  for (const line of existing.split("\n").filter(Boolean)) {
    git(clone, "config", "--local", "--unset", line.split(" ")[0] as string);
  }
  git(
    clone,
    "config",
    `url.${target}.insteadOf`,
    "git@github.com:acme/web.git",
  );
}

/**
 * A fresh fixture.
 * @param options - Extra config TOML, repository keys, manager options, and
 *   whether the clone has fetched origin yet.
 * @returns The fixture.
 */
export function fixture(
  options: {
    extra?: string;
    repo?: string;
    manager?: ManagerOptions;
    fetched?: boolean;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hyp-wt-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "# web\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", origin, "main");
  const clone = join(root, "web");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  git(clone, "remote", "add", "origin", "git@github.com:acme/web.git");
  routeOrigin(clone, origin);
  if (options.fetched !== false) {
    git(clone, "fetch", "-q", "origin");
    git(clone, "reset", "-q", "--hard", "origin/main");
  }
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
  ])
    git(clone, "config", key as string, value as string);
  const config = fakeConfig(
    root,
    [
      "[[repositories]]",
      'path = "~/web"',
      'base_branch = "main"',
      options.repo ?? "",
      "[sessions]",
      'worktree_root = "~/worktrees"',
      options.extra ?? "",
    ].join("\n"),
  );
  const state = new StateDb(":memory:");
  const manager = new WorktreeManager(state, {
    env: { HOME: root },
    ...options.manager,
  });
  return {
    root,
    origin,
    clone,
    config,
    repository: {
      name: "web",
      remote: REMOTE,
      baseBranch: "main",
      path: clone,
    },
    state,
    manager,
    events: [],
    log: [],
  };
}

/**
 * A work assignment on the fixture's repository.
 * @param overrides - Fields to change.
 * @returns The assignment.
 */
export function work(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return assignment({
    repository: { remote: REMOTE, baseBranch: "main" },
    ...overrides,
  });
}

/**
 * An acquisition request for a fixture, its session recorded as claimed.
 * @param f - The fixture.
 * @param a - The assignment.
 * @param signal - The turn's stop signal.
 * @returns The request.
 */
export function request(
  f: Fixture,
  a: WorkAssignment = work(),
  signal: AbortSignal = new AbortController().signal,
): AcquireRequest {
  f.state.claimSession({
    agentSessionId: a.agentSessionId,
    linearSessionId: a.externalSessionId,
    issueIdentifier: a.issue.identifier,
    role: a.role,
    repository: a.repository?.remote ?? null,
    workItemId: a.workItemId,
    acpAgentId: "fake",
  });
  return {
    assignment: a,
    config: f.config,
    repositories: [f.repository],
    runnerName: "test-runner",
    env: (branch) => ({
      PATH: process.env.PATH ?? "",
      HOME: f.root,
      HYPOTENUSE_SESSION_ID: String(a.agentSessionId),
      HYPOTENUSE_BRANCH: branch ?? "",
      HYPOTENUSE_ISSUE: a.issue.identifier ?? "",
    }),
    emit: (event) => f.events.push(event),
    output: (line) => f.log.push(line),
    signal,
  };
}

/**
 * Commit a file in a worktree.
 * @param cwd - The worktree.
 * @param name - The file.
 * @param message - The commit message.
 */
export function commit(cwd: string, name: string, message = name): void {
  writeFileSync(join(cwd, name), `${message}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", message);
}
