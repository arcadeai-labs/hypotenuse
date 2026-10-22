/**
 * `hypotenuse worktrees` — the git worktrees (and scratch directories) this
 * machine's daemon made for its sessions.
 *
 * - `worktrees list` — every one, with its size and whether the safety rules
 *   would let it be removed now.
 * - `worktrees cleanup [--dry-run] [--all] [--older-than 7d] [--force]` — the
 *   configured policy by default; `--all` takes every worktree not in use
 *   whatever its policy; `--older-than` only those unused that long; `--force`
 *   overrides the uncommitted, unpushed, and keep-file rules (never "in use").
 *   Kept worktrees are always printed with the reason.
 *
 * Both ask the running daemon. When none is running they read `state.db` and
 * scan the worktree root themselves (with a warning), so a person can still
 * clean up after uninstalling the service.
 */
import type { Command } from "commander";
import { checkConfig, formatIssue } from "../config/check";
import { parseDuration } from "../config/durations";
import { realMachine } from "../config/machine";
import { daemonPaths, tildify } from "../config/paths";
import type { Config } from "../config/schema";
import { type CliContext, emit, runCommand } from "../context";
import { daemonRepositories } from "../daemon/capabilities";
import { callDaemon, DaemonNotRunning } from "../daemon/control-client";
import { inspectLock } from "../daemon/pidfile";
import { StateDb } from "../daemon/state";
import { logger } from "../output/logger";
import { table } from "../output/theme";
import { ExitError } from "../shutdown";
import {
  type CleanupOptions,
  type CleanupReport,
  WorktreeCleaner,
} from "../worktree/cleanup";
import { formatBytes } from "../worktree/disk";
import { listWorktrees, type WorktreeListing } from "../worktree/list";
import { locateDaemon, notRunning } from "./daemon";

/** How long a `worktrees.cleanup` call may take (merge checks ask forges). */
const CLEANUP_TIMEOUT_MS = 600_000;

/** How long a `worktrees.list` call may take (sizes are measured). */
const LIST_TIMEOUT_MS = 120_000;

/**
 * How long ago, briefly: `now`, `12m`, `3h`, `4d`.
 * @param ms - Epoch milliseconds.
 * @param now - The current time.
 * @returns The text.
 */
export function ago(ms: number, now = Date.now()): string {
  const age = Math.max(0, now - ms);
  if (age < 60_000) return "now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

/**
 * Call the daemon, or — when it is not running — do the same thing offline.
 * A daemon that holds its lock but does not answer is not "not running":
 * cleaning up under it could race its turns.
 * @param ctx - The context.
 * @param method - The control method.
 * @param params - Its params.
 * @param timeoutMs - How long to wait for the daemon.
 * @param offline - The offline fallback.
 * @returns The result.
 */
async function daemonOrOffline<T>(
  ctx: CliContext,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  offline: (env: OfflineEnv) => Promise<T>,
): Promise<T> {
  const location = locateDaemon(ctx);
  try {
    return await callDaemon<T>(location.socket, method, params, timeoutMs);
  } catch (error) {
    if (!(error instanceof DaemonNotRunning)) throw error;
    const lock = await inspectLock(location.pidfile);
    if (
      lock.kind === "running" ||
      lock.kind === "starting" ||
      lock.kind === "hung"
    )
      notRunning(ctx, error);
  }
  const env = openOffline(ctx);
  logger.warn(
    `the daemon is not running; reading ${tildify(env.stateDbPath, ctx.env)} and scanning ${tildify(env.config.sessions.worktree_root, ctx.env)} directly`,
  );
  try {
    return await offline(env);
  } finally {
    env.state.close();
  }
}

/** What the offline fallback works with. */
interface OfflineEnv {
  config: Config;
  state: StateDb;
  stateDbPath: string;
  cleaner: WorktreeCleaner;
}

/**
 * Open the config and `state.db` without a daemon. No turn can be running
 * without one, so nothing counts as in use.
 * @param ctx - The context.
 * @returns The offline environment.
 */
function openOffline(ctx: CliContext): OfflineEnv {
  const checked = checkConfig(ctx.configPath, { env: ctx.env, offline: true });
  if (!checked.config) {
    throw new ExitError(
      1,
      checked.findings.errors
        .map((i) => formatIssue(i, ctx.configPath))
        .join("\n"),
    );
  }
  const config = checked.config;
  const paths = daemonPaths(
    ctx.configPath,
    ctx.options.stateDir,
    config.log.file,
    ctx.env,
  );
  const state = new StateDb(paths.stateDb);
  const repositories = daemonRepositories(config, realMachine(ctx.env));
  const cleaner = new WorktreeCleaner(state, () => config, {
    inUse: () => false,
    repositories: () => repositories,
  });
  return { config, state, stateDbPath: paths.stateDb, cleaner };
}

/**
 * The `worktrees list` table.
 * @param ctx - The context.
 * @param rows - The worktrees.
 * @returns The text.
 */
function listText(ctx: CliContext, rows: WorktreeListing[]): string {
  if (!rows.length) return "No worktrees.";
  return table(
    rows.map((w) => ({
      path: tildify(w.path, ctx.env),
      repo: w.repository,
      branch: w.branch || "-",
      issue: w.issueIdentifier ?? "-",
      state: w.state,
      "last used": ago(w.lastUsedAt),
      size: w.sizeBytes === null ? "?" : formatBytes(w.sizeBytes),
      "safe to remove": w.safeToRemove ? "yes" : `no (${w.reason})`,
    })),
    [
      { key: "path" },
      { key: "repo" },
      { key: "branch" },
      { key: "issue" },
      { key: "state" },
      { key: "last used" },
      { key: "size" },
      { key: "safe to remove" },
    ],
  );
}

/**
 * The `worktrees cleanup` report.
 * @param ctx - The context.
 * @param report - What happened.
 * @returns The text.
 */
function cleanupText(ctx: CliContext, report: CleanupReport): string {
  const lines: string[] = [];
  const verb = report.dryRun ? "Would remove" : "Removed";
  for (const r of report.removed) {
    const notes = [
      r.branch || null,
      r.branchDeleted ? "branch deleted" : null,
      r.discarded.length ? `discarding ${r.discarded.join(", ")}` : null,
    ].filter(Boolean);
    lines.push(
      `${verb} ${tildify(r.path, ctx.env)}${notes.length ? ` (${notes.join("; ")})` : ""}`,
    );
  }
  for (const k of report.kept)
    lines.push(`Kept ${tildify(k.path, ctx.env)}: ${k.reason}`);
  return lines.length ? lines.join("\n") : "No worktrees.";
}

/**
 * Register `worktrees list|cleanup`.
 * @param program - The root program.
 */
export function registerWorktreesCommands(program: Command): void {
  const worktrees = program
    .command("worktrees")
    .description("The worktrees this machine's daemon made for its sessions");
  worktrees
    .command("list")
    .description(
      "Every worktree, its size, and whether it is safe to remove now",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const rows = await daemonOrOffline<WorktreeListing[]>(
          ctx,
          "worktrees.list",
          {},
          LIST_TIMEOUT_MS,
          (env) => listWorktrees(env.state, env.cleaner),
        );
        emit(ctx, { worktrees: rows }, () => listText(ctx, rows));
      });
    });
  worktrees
    .command("cleanup")
    .description(
      "Remove worktrees the cleanup policy allows; kept ones are listed with the reason",
    )
    .option("--dry-run", "say what would be removed; remove nothing")
    .option("--all", "every worktree not in use, whatever the policy")
    .option(
      "--older-than <duration>",
      "only worktrees unused this long (e.g. 7d)",
    )
    .option(
      "--force",
      "remove despite uncommitted changes, unpushed commits, or a keep file (never one in use)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          dryRun?: boolean;
          all?: boolean;
          olderThan?: string;
          force?: boolean;
        };
        let olderThanMs: number | undefined;
        if (opts.olderThan !== undefined) {
          try {
            olderThanMs = parseDuration(opts.olderThan);
          } catch {
            throw new ExitError(
              2,
              `--older-than: "${opts.olderThan}" is not a duration (e.g. 7d, 12h)`,
            );
          }
        }
        const options: CleanupOptions = {
          dryRun: Boolean(opts.dryRun),
          all: Boolean(opts.all),
          force: Boolean(opts.force),
          ...(olderThanMs !== undefined ? { olderThanMs } : {}),
        };
        const report = await daemonOrOffline<CleanupReport>(
          ctx,
          "worktrees.cleanup",
          { ...options },
          CLEANUP_TIMEOUT_MS,
          (env) => env.cleaner.run(options),
        );
        emit(ctx, report, () => cleanupText(ctx, report));
      });
    });
}
