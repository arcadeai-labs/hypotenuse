/**
 * The worktree manager: where a session's turn works.
 *
 * - **A repository, `worktrees = "always"`** (the default): one git worktree per
 *   session at `<worktree_root>/<repo>/<ISSUE>` on `<prefix>/<issue>-<slug>`,
 *   created from a fresh fetch of `origin/<base_branch>`, prepared by the
 *   repository's setup commands, reused by every follow-up turn.
 * - **A repository, `worktrees = "never"`**: the person's own checkout, one
 *   session at a time (a lock file in its git directory), on the session's
 *   branch — and only from a clean tree. Hypotenuse never stashes, resets, or
 *   cleans a person's checkout.
 * - **A manager on a repository**: a read-only checkout — a worktree at the
 *   fresh base branch, **detached** (no branch is created), for the agent to
 *   read; removed when the turn ends, whatever the cleanup policy, because
 *   there is never anything in it to keep. `git worktree remove` without
 *   `--force` refuses a dirty one, which is then left to cleanup's safety rules.
 * - **No repository** (a manager writing tickets): a scratch directory,
 *   `<worktree_root>/_scratch/<agentSessionId>`.
 *
 * Creation runs under a per-repository mutex; setup runs outside it, so a
 * long `bun install` in one worktree does not hold up another session's.
 * Every failure is a {@link WorkspaceError} whose body is the turn's `error`.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeRemote,
  type WorkAssignment,
} from "../../../protocol/src/index";
import { formatDuration } from "../config/durations";
import type { ResolvedRepository } from "../config/machine";
import { tildify } from "../config/paths";
import type { Config, RepositoryConfig } from "../config/schema";
import type { EventInput } from "../daemon/event-sink";
import type { LocalWorktree, StateDb } from "../daemon/state";
import { branchName, issueDirectory, suffixed } from "./branch";
import { formatBytes, freeBytes, type StatFs } from "./disk";
import { type GitResult, type GitRunner, runGit, stderrTail } from "./git";
import { KeyedMutex, releaseCheckoutLock, takeCheckoutLock } from "./lock";
import { runSetup } from "./setup";

/** How long a fetch of the base branch may take. */
export const FETCH_TIMEOUT_MS = 120_000;

/** How often a session waiting for a checkout lock looks again. */
export const CHECKOUT_POLL_MS = 2_000;

/** The repository name scratch directories are recorded under. */
export const SCRATCH = "_scratch";

/** The git config key a branch's owning session is recorded in. */
const BRANCH_SESSION_KEY = "hypotenuseSession";

/** A turn's place to work. */
export interface Workspace {
  /** `worktree`, `checkout` (worktrees = "never"), `readonly` (a manager's detached checkout), or `scratch`. */
  mode: "worktree" | "checkout" | "readonly" | "scratch";
  /** The directory the agent runs in. */
  cwd: string;
  /** The branch, for a repository. */
  branch: string | null;
  /** The base branch, for a repository. */
  baseBranch: string | null;
  /** The `worktrees` row, when there is one. */
  worktreeId: number | null;
  /** The repository, when there is one. */
  repository: ResolvedRepository | null;
  /** The repository's config entry. */
  repositoryConfig: RepositoryConfig | null;
  /** Whether a follow-up reused it. */
  reused: boolean;
  /** Hand it back at the end of the turn. */
  release(): Promise<void>;
}

/** A failure that ends the turn with this `error`. */
export class WorkspaceError extends Error {
  /**
   * @param body - The error activity's body.
   */
  constructor(readonly body: string) {
    super(body);
    this.name = "WorkspaceError";
  }
}

/** What one acquisition needs. */
export interface AcquireRequest {
  assignment: WorkAssignment;
  config: Config;
  /** The repositories this daemon resolved. */
  repositories: ResolvedRepository[];
  /** This runner's name, for messages. */
  runnerName: string;
  /** The per-session environment for setup commands, given the branch. */
  env(branch: string | null): Record<string, string>;
  /** Report an event to the session. */
  emit(event: EventInput): void;
  /** A line for the session log. */
  output(line: string): void;
  /** Fires when the turn is stopped. */
  signal: AbortSignal;
}

/** The manager's collaborators (tests replace them). */
export interface ManagerOptions {
  git?: GitRunner;
  statfs?: StatFs;
  now?: () => number;
  mutex?: KeyedMutex;
  /** Run cleanup with the configured policy, when the disk guard trips. */
  freeSpace?: () => Promise<void>;
  /** Environment for `~` in messages. */
  env?: Record<string, string | undefined>;
}

/** Creates, reuses, and releases where turns work. */
export class WorktreeManager {
  readonly mutex: KeyedMutex;
  private readonly git: GitRunner;
  private readonly now: () => number;

  /**
   * @param state - The daemon's state database.
   * @param options - Collaborators.
   */
  constructor(
    private readonly state: StateDb,
    private readonly options: ManagerOptions = {},
  ) {
    this.git = options.git ?? runGit;
    this.now = options.now ?? Date.now;
    this.mutex = options.mutex ?? new KeyedMutex();
  }

  /**
   * A path as a person reads it.
   * @param path - The path.
   * @returns It, with `~`.
   */
  private home(path: string): string {
    return tildify(path, this.options.env ?? process.env);
  }

  /**
   * Bytes free on the worktree root's volume, and whether that is enough.
   * @param config - The config.
   * @returns The free bytes (null when unknown) and whether they suffice.
   */
  diskStatus(config: Config): { free: number | null; enough: boolean } {
    const free = freeBytes(config.sessions.worktree_root, this.options.statfs);
    return {
      free,
      enough: free === null || free >= config.sessions.min_free_disk,
    };
  }

  /**
   * Where a turn works, created or reused.
   * @param request - The turn.
   * @returns The workspace.
   * @throws {WorkspaceError} When it cannot be prepared.
   */
  async acquire(request: AcquireRequest): Promise<Workspace> {
    const remote = request.assignment.repository?.remote;
    if (!remote) return this.scratch(request);
    const wanted = normalizeRemote(remote);
    const repository = request.repositories.find((r) => r.remote === wanted);
    if (!repository) {
      throw new WorkspaceError(
        `Runner ${request.runnerName} has no repository \`${wanted}\` configured, so it cannot work on it.`,
      );
    }
    const repoConfig =
      request.config.repositories.find((r) => r.path === repository.path) ??
      null;
    const mode =
      repoConfig?.worktrees ?? request.config.sessions.worktrees ?? "always";
    const baseBranch =
      request.assignment.repository?.baseBranch ?? repository.baseBranch;
    if (request.assignment.role === "manager")
      return this.readOnly(request, repository, repoConfig, baseBranch);
    if (mode === "never")
      return this.checkout(request, repository, repoConfig, baseBranch);
    return this.worktree(request, repository, repoConfig, baseBranch);
  }

  /**
   * A manager's read-only checkout: the base branch's head, detached, made
   * fresh for each turn and removed at its end. No setup commands run — the
   * manager reads, it does not build.
   * @param request - The turn.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param baseBranch - The base branch.
   * @returns The workspace.
   */
  private async readOnly(
    request: AcquireRequest,
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    baseBranch: string,
  ): Promise<Workspace> {
    const id = request.assignment.agentSessionId;
    const row = await this.mutex.run(repository.path, async () => {
      this.refuseIfShort(request);
      await this.fetchBase(request, repository, baseBranch);
      const path = this.worktreePath(request, repository);
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      await this.git(["worktree", "prune"], { cwd: repository.path });
      await this.must(
        ["worktree", "add", "--detach", path, `origin/${baseBranch}`],
        repository.path,
        `create a read-only checkout of ${baseBranch}`,
      );
      const created = this.state.insertWorktree({
        kind: "worktree",
        repository: repository.name,
        repoPath: repository.path,
        path,
        branch: "",
        baseBranch,
        agentSessionId: id,
      });
      this.state.updateWorktree(created.id, { setupDone: true });
      request.output(
        `created read-only checkout ${path} at origin/${baseBranch} (detached)`,
      );
      return created;
    });
    return {
      mode: "readonly",
      cwd: row.path,
      branch: null,
      baseBranch,
      worktreeId: row.id,
      repository,
      repositoryConfig: repoConfig,
      reused: false,
      release: async () => this.removeReadOnly(row, request.output),
    };
  }

  /**
   * Remove a read-only checkout at the end of its turn. A dirty one (the
   * agent wrote despite the policy, through its own tools) is kept for the
   * usual cleanup, whose safety rules then decide.
   * @param row - The checkout.
   * @param output - A line for the session log.
   */
  private async removeReadOnly(
    row: LocalWorktree,
    output: (line: string) => void,
  ): Promise<void> {
    const repoPath = row.repoPath as string;
    await this.mutex.run(repoPath, async () => {
      const removed = await this.git(["worktree", "remove", row.path], {
        cwd: repoPath,
      });
      if (removed.code !== 0) {
        output(
          `kept read-only checkout ${row.path}: ${stderrTail(removed, 3)}`,
        );
        this.idle(row.id);
        return;
      }
      await this.git(["worktree", "prune"], { cwd: repoPath });
      this.state.updateWorktree(row.id, { state: "removed", keptReason: null });
      output(`removed read-only checkout ${row.path}`);
    });
  }

  /**
   * A repository-less turn's scratch directory.
   * @param request - The turn.
   * @returns The workspace.
   */
  private async scratch(request: AcquireRequest): Promise<Workspace> {
    const id = request.assignment.agentSessionId;
    const path = join(
      request.config.sessions.worktree_root,
      SCRATCH,
      String(id),
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const known = this.state.worktreeAt(path);
    let row: LocalWorktree;
    if (known && known.state !== "removed") {
      this.state.updateWorktree(known.id, { state: "active", touch: true });
      this.state.linkWorktree(id, known.id);
      row = known;
    } else {
      row = this.state.insertWorktree({
        kind: "scratch",
        repository: SCRATCH,
        repoPath: null,
        path,
        branch: "",
        baseBranch: "",
        agentSessionId: id,
      });
      this.state.updateWorktree(row.id, { setupDone: true });
    }
    return {
      mode: "scratch",
      cwd: path,
      branch: null,
      baseBranch: null,
      worktreeId: row.id,
      repository: null,
      repositoryConfig: null,
      reused: Boolean(known && known.state !== "removed"),
      release: async () => this.idle(row.id),
    };
  }

  /**
   * Mark a worktree no longer in use.
   * @param id - The row.
   */
  private idle(id: number): void {
    const row = this.state.worktree(id);
    if (row && row.state === "active")
      this.state.updateWorktree(id, { state: "idle", touch: true });
  }

  /**
   * Run git in a directory, failing the turn when it fails.
   * @param args - The arguments.
   * @param cwd - Where.
   * @param what - What it was for, for the error.
   * @returns The outcome.
   */
  private async must(
    args: string[],
    cwd: string,
    what: string,
  ): Promise<GitResult> {
    const result = await this.git(args, { cwd });
    if (result.code !== 0) {
      throw new WorkspaceError(
        `Could not ${what}: \`git ${args.join(" ")}\` failed.\n\n\`\`\`\n${stderrTail(result)}\n\`\`\``,
      );
    }
    return result;
  }

  /**
   * Whether a ref exists.
   * @param cwd - The clone.
   * @param ref - The full ref.
   * @returns True when it resolves.
   */
  private async hasRef(cwd: string, ref: string): Promise<boolean> {
    const result = await this.git(["show-ref", "--verify", "--quiet", ref], {
      cwd,
    });
    return result.code === 0;
  }

  /**
   * Fetch the base branch, falling back to the last fetched copy with a
   * thought, or failing without one.
   * @param request - The turn.
   * @param repository - The repository.
   * @param baseBranch - The base branch.
   * @returns Whether origin answered (the fetch worked).
   */
  private async fetchBase(
    request: AcquireRequest,
    repository: ResolvedRepository,
    baseBranch: string,
  ): Promise<boolean> {
    const fetched = await this.git(["fetch", "origin", baseBranch, "--prune"], {
      cwd: repository.path,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (fetched.code === 0) {
      // A bare `fetch origin <branch>` may only update FETCH_HEAD on an old
      // git or a narrow refspec; make sure the remote-tracking ref follows.
      await this.git(
        ["update-ref", `refs/remotes/origin/${baseBranch}`, "FETCH_HEAD"],
        { cwd: repository.path },
      );
      return true;
    }
    request.output(`git fetch failed: ${stderrTail(fetched)}`);
    if (
      await this.hasRef(repository.path, `refs/remotes/origin/${baseBranch}`)
    ) {
      const age = this.fetchAge(repository.path);
      request.emit({
        type: "thought",
        body: `Could not fetch ${repository.name}; working from the last fetched origin/${baseBranch}${age ? ` (${age} old)` : ""}.`,
        ephemeral: false,
      });
      return false;
    }
    throw new WorkspaceError(
      `Could not fetch \`${baseBranch}\` from ${repository.remote}, and ${this.home(repository.path)} has no earlier copy of origin/${baseBranch} to work from.\n\n\`\`\`\n${stderrTail(fetched)}\n\`\`\``,
    );
  }

  /**
   * How long ago the clone last fetched, from `FETCH_HEAD`'s age.
   * @param repoPath - The clone.
   * @returns E.g. `3h`, or null.
   */
  private fetchAge(repoPath: string): string | null {
    try {
      const age =
        this.now() - statSync(join(repoPath, ".git", "FETCH_HEAD")).mtimeMs;
      if (age < 60_000) return null;
      const units: [number, string][] = [
        [86_400_000, "d"],
        [3_600_000, "h"],
        [60_000, "m"],
      ];
      for (const [size, unit] of units)
        if (age >= size) return `${Math.floor(age / size)}${unit}`;
      return formatDuration(age);
    } catch {
      return null;
    }
  }

  /**
   * The disk guard, once cleanup has had its chance: fail the turn when free
   * space is still below `min_free_disk`.
   * @param request - The turn.
   * @throws {WorkspaceError} When space is short.
   */
  private refuseIfShort(request: AcquireRequest): void {
    const { free, enough } = this.diskStatus(request.config);
    if (enough || free === null) return;
    throw new WorkspaceError(
      `Runner ${request.runnerName} has only ${formatBytes(free)} free on the volume of ${this.home(request.config.sessions.worktree_root)}; a new worktree needs ${formatBytes(request.config.sessions.min_free_disk)}. Free some space, or run \`hypotenuse worktrees cleanup\` on that machine.`,
    );
  }

  /**
   * The session that owns a local branch, from git config.
   * @param repoPath - The clone.
   * @param branch - The branch.
   * @returns The session id, or null.
   */
  private async branchOwner(
    repoPath: string,
    branch: string,
  ): Promise<number | null> {
    const result = await this.git(
      ["config", "--get", `branch.${branch}.${BRANCH_SESSION_KEY}`],
      { cwd: repoPath },
    );
    const value = Number(result.stdout.trim());
    return result.code === 0 && Number.isInteger(value) ? value : null;
  }

  /**
   * Choose the session's branch: the one it already has, else the first of
   * `name`, `name-2`, … that exists nowhere — never an existing branch that
   * belongs to something else.
   * @param request - The turn.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param askOrigin - Whether origin can be asked about branches it has that
   *   this clone has not fetched (false when the fetch just failed).
   * @returns The branch, and where it exists already.
   */
  private async chooseBranch(
    request: AcquireRequest,
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    askOrigin: boolean,
  ): Promise<{ branch: string; local: boolean; remote: boolean }> {
    const { assignment } = request;
    const id = assignment.agentSessionId;
    const base = branchName(
      repoConfig?.branch_prefix ?? "hypotenuse",
      assignment.issue.identifier,
      assignment.issue.title,
      `session-${id}`,
    );
    const rows = this.state
      .worktrees()
      .filter((w) => w.repoPath === repository.path && w.kind === "worktree");
    const ours = new Set(
      rows.filter((w) => w.agentSessionId === id).map((w) => w.branch),
    );
    for (let n = 1; n < 100; n++) {
      const branch = suffixed(base, n);
      const local = await this.hasRef(repository.path, `refs/heads/${branch}`);
      const remote =
        (await this.hasRef(repository.path, `refs/remotes/origin/${branch}`)) ||
        (askOrigin &&
          (
            await this.git(["ls-remote", "--heads", "origin", branch], {
              cwd: repository.path,
              timeoutMs: 30_000,
            })
          ).stdout.trim() !== "");
      const owner = local
        ? await this.branchOwner(repository.path, branch)
        : null;
      const mine = owner === id || (owner === null && ours.has(branch));
      const takenByRow = rows.some(
        (w) =>
          w.branch === branch &&
          w.agentSessionId !== id &&
          w.state !== "removed",
      );
      if (takenByRow) continue;
      if ((local || remote) && !mine) continue;
      return { branch, local, remote };
    }
    throw new WorkspaceError(
      `Could not find a free branch name for ${base} in ${repository.name}.`,
    );
  }

  /**
   * The worktree path for a new worktree: `<root>/<repo>/<ISSUE>`, then
   * `-2`, `-3`, … while taken.
   * @param request - The turn.
   * @param repository - The repository.
   * @returns The path.
   */
  private worktreePath(
    request: AcquireRequest,
    repository: ResolvedRepository,
  ): string {
    const dir = issueDirectory(
      request.assignment.issue.identifier,
      `session-${request.assignment.agentSessionId}`,
    );
    const parent = join(request.config.sessions.worktree_root, repository.name);
    for (let n = 1; ; n++) {
      const path = join(parent, suffixed(dir, n));
      const row = this.state.worktreeAt(path);
      if (!existsSync(path) && (!row || row.state === "removed")) return path;
    }
  }

  /**
   * A session's git worktree.
   * @param request - The turn.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param baseBranch - The base branch.
   * @returns The workspace.
   */
  private async worktree(
    request: AcquireRequest,
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    baseBranch: string,
  ): Promise<Workspace> {
    // Short on disk, cleanup runs *outside* the repository's mutex — it takes
    // that mutex itself for each worktree it considers — and then the
    // acquisition starts over.
    let cleaned = false;
    for (;;) {
      const outcome = await this.createOrReuse(
        request,
        repository,
        repoConfig,
        baseBranch,
        cleaned,
      );
      if (outcome === "short") {
        cleaned = true;
        await this.options.freeSpace?.();
        continue;
      }
      const { row, reused } = outcome;
      if (!row.setupDone) await this.setup(request, row, repoConfig);
      return {
        mode: "worktree",
        cwd: row.path,
        branch: row.branch,
        baseBranch: row.baseBranch,
        worktreeId: row.id,
        repository,
        repositoryConfig: repoConfig,
        reused,
        release: async () => this.idle(row.id),
      };
    }
  }

  /**
   * Under the repository's mutex: reuse the session's worktree, or fetch and
   * create one — unless a new one is needed and the disk is short.
   * @param request - The turn.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param baseBranch - The base branch.
   * @param cleaned - Whether cleanup already ran for this acquisition.
   * @returns The worktree, or `short` when cleanup should run first.
   * @throws {WorkspaceError} When space is still short after cleanup.
   */
  private createOrReuse(
    request: AcquireRequest,
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    baseBranch: string,
    cleaned: boolean,
  ): Promise<{ row: LocalWorktree; reused: boolean } | "short"> {
    const id = request.assignment.agentSessionId;
    return this.mutex.run(repository.path, async () => {
      const previous = this.reusable(id);
      if (previous) {
        const head = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: previous.path,
        });
        if (head.code === 0 && head.stdout.trim() === previous.branch) {
          this.state.updateWorktree(previous.id, {
            state: "active",
            touch: true,
          });
          this.state.linkWorktree(id, previous.id);
          return { row: previous, reused: true };
        }
        request.output(
          `not reusing ${previous.path}: HEAD is ${head.stdout.trim() || "unreadable"}, not ${previous.branch}`,
        );
      }
      if (!this.diskStatus(request.config).enough) {
        if (!cleaned) return "short" as const;
        this.refuseIfShort(request);
      }
      const reachable = await this.fetchBase(request, repository, baseBranch);
      const { branch, local, remote } = await this.chooseBranch(
        request,
        repository,
        repoConfig,
        reachable,
      );
      const path = this.worktreePath(request, repository);
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      await this.git(["worktree", "prune"], { cwd: repository.path });
      let add: string[];
      if (local) {
        add = ["worktree", "add", path, branch];
      } else if (remote) {
        await this.git(
          [
            "fetch",
            "origin",
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
          ],
          { cwd: repository.path, timeoutMs: FETCH_TIMEOUT_MS },
        );
        add = ["worktree", "add", "-b", branch, path, `origin/${branch}`];
      } else {
        add = ["worktree", "add", "-b", branch, path, `origin/${baseBranch}`];
      }
      await this.must(add, repository.path, `create a worktree for ${branch}`);
      await this.git(
        ["config", `branch.${branch}.${BRANCH_SESSION_KEY}`, String(id)],
        { cwd: repository.path },
      );
      await this.git(["config", "extensions.worktreeConfig", "true"], {
        cwd: repository.path,
      });
      await this.git(
        ["config", "--worktree", "hypotenuse.session", String(id)],
        {
          cwd: path,
        },
      );
      const identifier = request.assignment.issue.identifier;
      if (identifier)
        await this.git(
          ["config", "--worktree", "hypotenuse.issue", identifier],
          {
            cwd: path,
          },
        );
      const created = this.state.insertWorktree({
        kind: "worktree",
        repository: repository.name,
        repoPath: repository.path,
        path,
        branch,
        baseBranch,
        agentSessionId: id,
      });
      request.output(
        `created worktree ${path} on ${branch} from origin/${baseBranch}`,
      );
      return { row: created, reused: false };
    });
  }

  /**
   * The session's last worktree, if it still exists on disk.
   * @param agentSessionId - The session.
   * @returns The row, or null.
   */
  private reusable(agentSessionId: number): LocalWorktree | null {
    const session = this.state.session(agentSessionId);
    const row = session?.worktreeId
      ? this.state.worktree(session.worktreeId)
      : null;
    if (
      !row ||
      row.kind !== "worktree" ||
      row.state === "removed" ||
      !existsSync(row.path)
    )
      return null;
    return row;
  }

  /**
   * Run the repository's setup commands in a worktree that has not had them.
   * @param request - The turn.
   * @param row - The worktree.
   * @param repoConfig - Its repository.
   */
  private async setup(
    request: AcquireRequest,
    row: LocalWorktree,
    repoConfig: RepositoryConfig | null,
  ): Promise<void> {
    const commands = repoConfig?.setup ?? [];
    if (commands.length) {
      const failed = await runSetup(commands, {
        cwd: row.path,
        env: request.env(row.branch),
        timeoutMs: repoConfig?.setup_timeout ?? 600_000,
        emit: request.emit,
        output: (line) => request.output(`setup: ${line}`),
        signal: request.signal,
        now: this.now,
      });
      if (failed) {
        this.idle(row.id);
        if (failed.cancelled) throw new WorkspaceError("stopped");
        const why = failed.timedOut
          ? `timed out after ${formatDuration(repoConfig?.setup_timeout ?? 600_000)}`
          : `exited with code ${failed.code ?? "signal"}`;
        throw new WorkspaceError(
          `Setup command \`${failed.command}\` ${why}. The worktree is kept for inspection at \`${this.home(row.path)}\` on runner ${request.runnerName}.${failed.tail ? `\n\n\`\`\`\n${failed.tail}\n\`\`\`` : ""}`,
        );
      }
    }
    this.state.updateWorktree(row.id, { setupDone: true });
  }

  /**
   * `worktrees = "never"`: the person's checkout, on the session's branch.
   * @param request - The turn.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param baseBranch - The base branch.
   * @returns The workspace.
   */
  private async checkout(
    request: AcquireRequest,
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    baseBranch: string,
  ): Promise<Workspace> {
    const id = request.assignment.agentSessionId;
    const gitDir = (
      await this.must(
        ["rev-parse", "--absolute-git-dir"],
        repository.path,
        "read the repository",
      )
    ).stdout.trim();
    const lockFile = join(gitDir, "hypotenuse.lock");
    await this.waitForCheckout(request, repository, lockFile);
    try {
      return await this.mutex.run(repository.path, async () => {
        const head = (
          await this.must(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            repository.path,
            "read the current branch",
          )
        ).stdout.trim();
        const onOurs =
          head !== "HEAD" &&
          (await this.branchOwner(repository.path, head)) === id;
        const status = await this.must(
          ["status", "--porcelain"],
          repository.path,
          "read the checkout's status",
        );
        if (status.stdout.trim() && !onOurs) {
          throw new WorkspaceError(
            `${this.home(repository.path)} has uncommitted changes, and this repository is set to \`worktrees = "never"\`, so the agent would work in it directly. Hypotenuse never stashes, resets, or cleans a person's checkout: commit or stash the changes on runner ${request.runnerName}, then reply to try again.`,
          );
        }
        if (onOurs) {
          return this.checkoutWorkspace(
            repository,
            repoConfig,
            baseBranch,
            head,
            head,
            lockFile,
            id,
          );
        }
        const reachable = await this.fetchBase(request, repository, baseBranch);
        const { branch, local } = await this.chooseBranch(
          request,
          repository,
          repoConfig,
          reachable,
        );
        await this.must(
          local
            ? ["switch", branch]
            : ["switch", "-c", branch, `origin/${baseBranch}`],
          repository.path,
          `switch to ${branch}`,
        );
        await this.git(
          ["config", `branch.${branch}.${BRANCH_SESSION_KEY}`, String(id)],
          { cwd: repository.path },
        );
        if (repoConfig?.setup.length) {
          const failed = await runSetup(repoConfig.setup, {
            cwd: repository.path,
            env: request.env(branch),
            timeoutMs: repoConfig.setup_timeout,
            emit: request.emit,
            output: (line) => request.output(`setup: ${line}`),
            signal: request.signal,
            now: this.now,
          });
          if (failed && !failed.cancelled) {
            throw new WorkspaceError(
              `Setup command \`${failed.command}\` failed in ${this.home(repository.path)}.${failed.tail ? `\n\n\`\`\`\n${failed.tail}\n\`\`\`` : ""}`,
            );
          }
          if (failed) throw new WorkspaceError("stopped");
        }
        return this.checkoutWorkspace(
          repository,
          repoConfig,
          baseBranch,
          branch,
          head,
          lockFile,
          id,
        );
      });
    } catch (error) {
      releaseCheckoutLock(lockFile, id);
      throw error;
    }
  }

  /**
   * The workspace of a person's checkout, whose release switches back to the
   * branch they were on when the tree is clean.
   * @param repository - The repository.
   * @param repoConfig - Its config entry.
   * @param baseBranch - The base branch.
   * @param branch - The session's branch.
   * @param previous - The branch to return to.
   * @param lockFile - The checkout lock.
   * @param id - The session.
   * @returns The workspace.
   */
  private checkoutWorkspace(
    repository: ResolvedRepository,
    repoConfig: RepositoryConfig | null,
    baseBranch: string,
    branch: string,
    previous: string,
    lockFile: string,
    id: number,
  ): Workspace {
    return {
      mode: "checkout",
      cwd: repository.path,
      branch,
      baseBranch,
      worktreeId: null,
      repository,
      repositoryConfig: repoConfig,
      reused: previous === branch,
      release: async () => {
        try {
          await this.mutex.run(repository.path, async () => {
            if (previous === branch || previous === "HEAD") return;
            const status = await this.git(["status", "--porcelain"], {
              cwd: repository.path,
            });
            if (status.code === 0 && !status.stdout.trim())
              await this.git(["switch", previous], { cwd: repository.path });
          });
        } finally {
          releaseCheckoutLock(lockFile, id);
        }
      },
    };
  }

  /**
   * Take the checkout lock, waiting (with one thought) while another session
   * holds it.
   * @param request - The turn.
   * @param repository - The repository.
   * @param lockFile - The lock file.
   */
  private async waitForCheckout(
    request: AcquireRequest,
    repository: ResolvedRepository,
    lockFile: string,
  ): Promise<void> {
    const id = request.assignment.agentSessionId;
    let said = false;
    for (;;) {
      if (request.signal.aborted) throw new WorkspaceError("stopped");
      const held = await this.mutex.run(repository.path, async () =>
        takeCheckoutLock(lockFile, id),
      );
      if (!held) return;
      if (!said) {
        said = true;
        request.emit({
          type: "thought",
          body: `Waiting for another session to finish in ${repository.name}: it is set to work in the checkout itself, one session at a time.`,
          ephemeral: true,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHECKOUT_POLL_MS);
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
