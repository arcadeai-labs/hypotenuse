/**
 * The parts of this machine the config is checked against — `PATH`, `git`,
 * and the filesystem — behind one interface, so validation is a pure function
 * over `(config, machine)` and its tests state a machine instead of needing
 * one.
 */
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { normalizeRemote } from "../../../protocol/src/index";
import type { Env } from "./paths";
import { repositoryName } from "./resolve";
import type { RepositoryConfig } from "./schema";

/** A command's outcome. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What validation may ask of the machine. */
export interface MachineEnv {
  /** Environment variables. */
  env: Env;
  /**
   * Find a command on `PATH`.
   * @param command - A bare name, or a path.
   * @returns Its absolute path, or null.
   */
  which(command: string): string | null;
  /**
   * Run git.
   * @param args - Arguments after `git`.
   * @param cwd - Where.
   * @returns The outcome.
   */
  git(args: string[], cwd?: string): RunResult;
  /**
   * Whether a path exists.
   * @param path - The path.
   */
  exists(path: string): boolean;
  /**
   * Whether a path is a directory.
   * @param path - The path.
   */
  isDirectory(path: string): boolean;
  /**
   * Whether a directory can be created or written at a path: the path, or its
   * nearest existing ancestor, is writable.
   * @param path - The path.
   */
  isWritable(path: string): boolean;
  /**
   * Read a text file.
   * @param path - The file.
   * @returns Its contents, or null when it cannot be read.
   */
  readFile(path: string): string | null;
}

/**
 * This machine.
 * @param env - Environment variables (`PATH` among them).
 * @returns The real implementation.
 */
export function realMachine(env: Env = process.env): MachineEnv {
  return {
    env,
    which: (command) => Bun.which(command, { PATH: env.PATH ?? "" }),
    git: (args, cwd) => {
      try {
        const proc = Bun.spawnSync(["git", ...args], {
          cwd,
          env: { ...env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        return {
          code: proc.exitCode ?? 1,
          stdout: proc.stdout.toString(),
          stderr: proc.stderr.toString(),
        };
      } catch (error) {
        return {
          code: 127,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
    exists: (path) => existsSync(path),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isWritable: (path) => {
      let current = path;
      for (;;) {
        if (existsSync(current)) {
          try {
            accessSync(current, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        }
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** The oldest git this daemon works with (`worktree list --porcelain -z`). */
export const MIN_GIT_VERSION = [2, 38] as const;

/**
 * Parse `git --version`.
 * @param output - E.g. `git version 2.43.0` or `git version 2.39.3 (Apple Git-146)`.
 * @returns `[major, minor, patch]`, or null.
 */
export function parseGitVersion(
  output: string,
): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** A repository as the daemon reports it: its name, normalized remote, and base. */
export interface ResolvedRepository {
  name: string;
  remote: string;
  baseBranch: string;
  path: string;
}

/**
 * The `origin` remote of a clone, normalized.
 * @param machine - The machine.
 * @param path - The clone.
 * @returns The remote, or null when there is no origin.
 */
export function originOf(machine: MachineEnv, path: string): string | null {
  const result = machine.git(["config", "--get", "remote.origin.url"], path);
  const url = result.stdout.trim();
  return result.code === 0 && url ? normalizeRemote(url) : null;
}

/**
 * The branch `origin/HEAD` points at, if the clone knows.
 * @param machine - The machine.
 * @param path - The clone.
 * @returns The branch name, or null.
 */
export function originHead(machine: MachineEnv, path: string): string | null {
  const result = machine.git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    path,
  );
  const ref = result.stdout.trim();
  return result.code === 0 && ref.startsWith("origin/")
    ? ref.slice("origin/".length)
    : null;
}

/**
 * Fill in what a repository entry leaves out: its remote is the clone's
 * origin, and `base_branch` comes from `origin/HEAD` (else `main`).
 * @param machine - The machine.
 * @param repo - The entry.
 * @returns The repository as the daemon reports it, or null when the clone
 *   has no origin.
 */
export function resolveRepository(
  machine: MachineEnv,
  repo: RepositoryConfig,
): ResolvedRepository | null {
  const remote = originOf(machine, repo.path);
  if (!remote) return null;
  return {
    name: repositoryName(repo, remote),
    remote,
    baseBranch: repo.base_branch ?? originHead(machine, repo.path) ?? "main",
    path: repo.path,
  };
}
