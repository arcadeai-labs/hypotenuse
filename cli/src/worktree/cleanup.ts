/**
 * Worktree cleanup. A policy decides **when** a worktree may go; the safety
 * rules decide **whether** it is safe to, and always win.
 *
 * | Policy | Eligible when |
 * |---|---|
 * | `on-complete` | the session's last turn answered with a `response` (Linear marks it complete) and no turn has started for `cleanup_grace` |
 * | `on-merge` | its pull request is merged or closed, or its branch is gone from origin |
 * | `ttl` | unused for `cleanup_ttl` |
 * | `never` | only `worktrees cleanup --all` or `--older-than` |
 *
 * Safety rules, in order — each **keeps** the worktree and says why:
 *
 * 1. a turn is claimed or running in it → `in use` (never overridden);
 * 2. `git status --porcelain` is not empty → `uncommitted changes`;
 * 3. its branch has commits on no remote → `unpushed commits`;
 * 4. a `.hypotenuse-keep` file → `kept by request`.
 *
 * `--force` overrides rules 2–4 and reports what it discards. Removal is
 * `git worktree remove` (which refuses a dirty tree on its own), `git
 * worktree prune`, and `git branch -d` — never `-D` — only for a branch with
 * nothing unpushed. Scratch directories have no git, so only rules 1 and 4
 * apply to them.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ResolvedRepository } from "../config/machine";
import type { Config } from "../config/schema";
import {
  LIVE_LOCAL_STATES,
  type LocalWorktree,
  type StateDb,
} from "../daemon/state";
import { type GitRunner, runGit, stderrTail } from "./git";
import { KeyedMutex } from "./lock";
import { SCRATCH } from "./manager";
import { MergeStateChecker } from "./merge-state";

/** The file a person drops in a worktree to keep it. */
export const KEEP_FILE = ".hypotenuse-keep";

/** How often the daemon sweeps every worktree. */
export const SWEEP_INTERVAL_MS = 30 * 60_000;

/** What to clean up. */
export interface CleanupOptions {
  /** Say what would happen; change nothing. */
  dryRun?: boolean;
  /** Every worktree not in use, whatever its policy. */
  all?: boolean;
  /** Only worktrees unused for this long (ms); ignores the policy too. */
  olderThanMs?: number;
  /** Override safety rules 2–4. */
  force?: boolean;
  /** Only these worktree ids. */
  only?: number[];
}

/** One worktree removed (or, in a dry run, that would be). */
export interface RemovedWorktree {
  path: string;
  repository: string;
  branch: string;
  /** Whether the local branch was deleted too. */
  branchDeleted: boolean;
  /** What `--force` discarded. */
  discarded: string[];
}

/** One worktree kept, and why. */
export interface KeptWorktree {
  path: string;
  repository: string;
  branch: string;
  reason: string;
}

/** What a cleanup did. */
export interface CleanupReport {
  dryRun: boolean;
  removed: RemovedWorktree[];
  kept: KeptWorktree[];
}

/** The cleaner's collaborators. */
export interface CleanerOptions {
  git?: GitRunner;
  mergeState?: MergeStateChecker;
  mutex?: KeyedMutex;
  now?: () => number;
  /**
   * Whether a turn holds a worktree (rule 1). Defaults to its row being
   * `active` or its session's turn being live in `local_sessions`.
   */
  inUse?: (wt: LocalWorktree) => boolean;
  /** The repositories, for adopting worktrees `state.db` forgot. */
  repositories?: () => ResolvedRepository[];
  /** A line for the daemon log. */
  log?: (line: string) => void;
}

/** Applies the cleanup policies and safety rules. */
export class WorktreeCleaner {
  private readonly git: GitRunner;
  private readonly mergeState: MergeStateChecker;
  readonly mutex: KeyedMutex;
  private readonly now: () => number;

  /**
   * @param state - The daemon's state database.
   * @param config - The current config (a function: reloads apply).
   * @param options - Collaborators.
   */
  constructor(
    private readonly state: StateDb,
    private readonly config: () => Config,
    private readonly options: CleanerOptions = {},
  ) {
    this.git = options.git ?? runGit;
    this.mergeState = options.mergeState ?? new MergeStateChecker();
    this.mutex = options.mutex ?? new KeyedMutex();
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether a turn holds a worktree's session.
   * @param wt - The worktree.
   * @returns True when it is in use.
   */
  private inUse(wt: LocalWorktree): boolean {
    if (this.options.inUse) return this.options.inUse(wt);
    if (wt.state === "active") return true;
    if (wt.agentSessionId === null) return false;
    const session = this.state.session(wt.agentSessionId);
    return Boolean(
      session &&
        LIVE_LOCAL_STATES.includes(session.state) &&
        session.worktreeId === wt.id,
    );
  }

  /**
   * The policy a worktree is under.
   * @param wt - The worktree.
   * @returns The policy name.
   */
  policyOf(wt: LocalWorktree): Config["sessions"]["cleanup"] {
    const config = this.config();
    const repo = config.repositories.find((r) => r.path === wt.repoPath);
    return repo?.cleanup ?? config.sessions.cleanup;
  }

  /**
   * Why a worktree is not yet eligible under its policy (or the options).
   * @param wt - The worktree.
   * @param options - `--all`, `--older-than`.
   * @returns Null when eligible, else the reason.
   */
  async ineligible(
    wt: LocalWorktree,
    options: CleanupOptions = {},
  ): Promise<string | null> {
    const age = this.now() - wt.lastUsedAt;
    if (options.olderThanMs !== undefined) {
      return age >= options.olderThanMs ? null : "used too recently";
    }
    if (options.all) return null;
    const config = this.config();
    const policy = this.policyOf(wt);
    switch (policy) {
      case "never":
        return "cleanup = never";
      case "ttl": {
        const ttl = config.sessions.cleanup_ttl;
        return ttl !== undefined && age >= ttl ? null : "within cleanup_ttl";
      }
      case "on-merge": {
        if (wt.kind === "scratch" || !wt.repoPath || !wt.branch)
          return "no pull request to wait for";
        const state = await this.mergeState.check(wt.repoPath, wt.branch);
        return state === "merged" || state === "closed" || state === "gone"
          ? null
          : state === "open"
            ? "pull request not merged"
            : "merge state unknown";
      }
      default: {
        const session =
          wt.agentSessionId !== null
            ? this.state.session(wt.agentSessionId)
            : null;
        if (!session || session.state !== "idle" || session.endedAt === null)
          return "session not complete";
        if (session.lastAnswer !== "response")
          return session.lastAnswer === "elicitation"
            ? "session awaiting input"
            : "session not complete";
        return this.now() - session.endedAt >= config.sessions.cleanup_grace
          ? null
          : "within cleanup_grace";
      }
    }
  }

  /**
   * The safety rules that keep a worktree, in order. With `force`, rules 2–4
   * are reported as discarded instead.
   * @param wt - The worktree.
   * @returns The first keeping reason (null when safe), and what force would discard.
   */
  async safety(
    wt: LocalWorktree,
  ): Promise<{ reason: string | null; overridable: string[] }> {
    if (this.inUse(wt)) return { reason: "in use", overridable: [] };
    const reasons: string[] = [];
    if (wt.kind === "worktree" && existsSync(wt.path)) {
      const status = await this.git(
        ["status", "--porcelain", "--", ".", `:(exclude)${KEEP_FILE}`],
        { cwd: wt.path },
      );
      if (status.code !== 0 || status.stdout.trim())
        reasons.push("uncommitted changes");
      if (await this.hasUnpushed(wt)) reasons.push("unpushed commits");
    }
    if (existsSync(join(wt.path, KEEP_FILE))) reasons.push("kept by request");
    return { reason: reasons[0] ?? null, overridable: reasons };
  }

  /**
   * Whether a worktree's branch has commits on no remote.
   * @param wt - The worktree.
   * @returns True when it has.
   */
  private async hasUnpushed(wt: LocalWorktree): Promise<boolean> {
    if (!wt.repoPath || !wt.branch) return false;
    const result = await this.git(
      [
        "rev-list",
        "--max-count=1",
        `refs/heads/${wt.branch}`,
        "--not",
        "--remotes",
      ],
      { cwd: wt.repoPath },
    );
    if (result.code !== 0) return false;
    return result.stdout.trim() !== "";
  }

  /**
   * Record worktrees git and the disk know that `state.db` does not: a git
   * worktree under the root carrying `hypotenuse.session`, or a scratch
   * directory. They are adopted `idle`.
   * @returns How many were adopted.
   */
  async adopt(): Promise<number> {
    const root = resolve(this.config().sessions.worktree_root);
    const known = new Set(
      this.state.worktrees({ live: true }).map((w) => w.path),
    );
    let adopted = 0;
    for (const repo of this.options.repositories?.() ?? []) {
      const list = await this.git(["worktree", "list", "--porcelain"], {
        cwd: repo.path,
      });
      if (list.code !== 0) continue;
      for (const block of list.stdout.split("\n\n")) {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
        if (!path || !branch || known.has(path)) continue;
        const rel = relative(root, path);
        if (rel.startsWith("..") || rel === "") continue;
        const session = await this.git(
          ["config", "--worktree", "--get", "hypotenuse.session"],
          { cwd: path },
        );
        const id = Number(session.stdout.trim());
        if (session.code !== 0 || !Number.isInteger(id)) continue;
        const row = this.state.insertWorktree({
          kind: "worktree",
          repository: repo.name,
          repoPath: repo.path,
          path,
          branch,
          baseBranch: repo.baseBranch,
          agentSessionId: id,
        });
        this.state.updateWorktree(row.id, { state: "idle", setupDone: true });
        known.add(path);
        adopted++;
      }
    }
    const scratch = join(root, SCRATCH);
    if (existsSync(scratch)) {
      for (const name of readdirSync(scratch)) {
        const path = join(scratch, name);
        const id = Number(name);
        if (known.has(path) || !Number.isInteger(id)) continue;
        const row = this.state.insertWorktree({
          kind: "scratch",
          repository: SCRATCH,
          repoPath: null,
          path,
          branch: "",
          baseBranch: "",
          agentSessionId: id,
        });
        this.state.updateWorktree(row.id, { state: "idle", setupDone: true });
        adopted++;
      }
    }
    if (adopted)
      this.options.log?.(
        `adopted ${adopted} worktree(s) state.db did not know`,
      );
    return adopted;
  }

  /**
   * Clean up: every live worktree (or `only`), eligible by policy (or the
   * options), removed if the safety rules allow.
   * @param options - What to clean up, and how.
   * @returns What was removed and what was kept, with reasons.
   */
  async run(options: CleanupOptions = {}): Promise<CleanupReport> {
    const report: CleanupReport = {
      dryRun: Boolean(options.dryRun),
      removed: [],
      kept: [],
    };
    if (!options.only) await this.adopt();
    const rows = this.state
      .worktrees({ live: true })
      .filter((w) => !options.only || options.only.includes(w.id));
    for (const wt of rows) {
      const key = wt.repoPath ?? wt.path;
      await this.mutex.run(key, async () => {
        const fresh = this.state.worktree(wt.id);
        if (!fresh || fresh.state === "removed") return;
        await this.consider(fresh, options, report);
      });
    }
    return report;
  }

  /**
   * Decide about one worktree, and remove it if allowed.
   * @param wt - The worktree (re-read under its repository's mutex).
   * @param options - What to clean up, and how.
   * @param report - Where the outcome goes.
   */
  private async consider(
    wt: LocalWorktree,
    options: CleanupOptions,
    report: CleanupReport,
  ): Promise<void> {
    const keep = (reason: string) => {
      report.kept.push({
        path: wt.path,
        repository: wt.repository,
        branch: wt.branch,
        reason,
      });
      if (!options.dryRun)
        this.state.updateWorktree(wt.id, { keptReason: reason });
    };
    if (!existsSync(wt.path)) {
      // Gone already (removed by hand): forget it.
      if (!options.dryRun) {
        if (wt.repoPath)
          await this.git(["worktree", "prune"], { cwd: wt.repoPath });
        this.state.updateWorktree(wt.id, {
          state: "removed",
          keptReason: null,
        });
      }
      report.removed.push({
        path: wt.path,
        repository: wt.repository,
        branch: wt.branch,
        branchDeleted: false,
        discarded: [],
      });
      return;
    }
    if (this.inUse(wt)) return keep("in use");
    const why = await this.ineligible(wt, options);
    if (why) return keep(`not eligible (${why})`);
    const safety = await this.safety(wt);
    if (safety.reason && !options.force) return keep(safety.reason);
    const discarded = options.force ? safety.overridable : [];
    if (options.dryRun) {
      report.removed.push({
        path: wt.path,
        repository: wt.repository,
        branch: wt.branch,
        branchDeleted: false,
        discarded,
      });
      return;
    }
    const outcome = await this.remove(
      wt,
      options.force === true && discarded.length > 0,
    );
    if (outcome.error) return keep(`removal failed: ${outcome.error}`);
    report.removed.push({
      path: wt.path,
      repository: wt.repository,
      branch: wt.branch,
      branchDeleted: outcome.branchDeleted,
      discarded,
    });
    this.options.log?.(
      `removed worktree ${wt.path}${discarded.length ? ` (discarding ${discarded.join(", ")})` : ""}`,
    );
  }

  /**
   * Remove a worktree, prune, and delete its branch when that loses nothing.
   * @param wt - The worktree.
   * @param force - Discard uncommitted changes.
   * @returns Whether the branch went too, or the error.
   */
  private async remove(
    wt: LocalWorktree,
    force: boolean,
  ): Promise<{ branchDeleted: boolean; error?: string }> {
    if (wt.kind === "scratch" || !wt.repoPath) {
      rmSync(wt.path, { recursive: true, force: true });
      this.state.updateWorktree(wt.id, { state: "removed", keptReason: null });
      return { branchDeleted: false };
    }
    const removed = await this.git(
      ["worktree", "remove", ...(force ? ["--force"] : []), wt.path],
      { cwd: wt.repoPath },
    );
    if (removed.code !== 0)
      return { branchDeleted: false, error: stderrTail(removed, 3) };
    await this.git(["worktree", "prune"], { cwd: wt.repoPath });
    let branchDeleted = false;
    if (wt.branch && !(await this.hasUnpushed(wt))) {
      const deleted = await this.git(["branch", "-d", wt.branch], {
        cwd: wt.repoPath,
      });
      branchDeleted = deleted.code === 0;
    }
    this.state.updateWorktree(wt.id, { state: "removed", keptReason: null });
    return { branchDeleted };
  }
}
