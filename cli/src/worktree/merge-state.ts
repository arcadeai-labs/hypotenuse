/**
 * Whether a branch's work has landed, for the `on-merge` cleanup policy:
 *
 * 1. `gh pr view <branch> --json state,mergedAt`, when `gh` is installed and
 *    answers — `MERGED` or `CLOSED` counts;
 * 2. otherwise `git ls-remote --heads origin <branch>` — a branch gone from
 *    origin counts as merged or closed.
 *
 * Each answer is cached for ten minutes, so the half-hourly sweep stays cheap
 * on a runner with many worktrees.
 */
import { type GitRunner, runGit } from "./git";

/** How long an answer is kept. */
export const MERGE_STATE_TTL_MS = 10 * 60_000;

/** What is known about a branch's pull request. */
export type MergeState = "merged" | "closed" | "gone" | "open" | "unknown";

/** Runs `gh`. Injectable for tests. */
export type GhRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string } | null>;

/**
 * Run `gh` if it is installed.
 * @param args - Arguments after `gh`.
 * @param cwd - The clone.
 * @returns Its outcome, or null when there is no `gh`.
 */
export const runGh: GhRunner = async (args, cwd) => {
  const gh = Bun.which("gh");
  if (!gh) return null;
  try {
    const proc = Bun.spawn([gh, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return null;
  }
};

/** Asks, and remembers, whether branches have landed. */
export class MergeStateChecker {
  private readonly cache = new Map<string, { state: MergeState; at: number }>();

  /**
   * @param options - Collaborators (tests replace them).
   */
  constructor(
    private readonly options: {
      gh?: GhRunner;
      git?: GitRunner;
      now?: () => number;
    } = {},
  ) {}

  /**
   * A branch's merge state.
   * @param repoPath - The clone.
   * @param branch - The branch.
   * @returns The state.
   */
  async check(repoPath: string, branch: string): Promise<MergeState> {
    const now = (this.options.now ?? Date.now)();
    const key = `${repoPath}\0${branch}`;
    const cached = this.cache.get(key);
    if (cached && now - cached.at < MERGE_STATE_TTL_MS) return cached.state;
    const state = await this.ask(repoPath, branch);
    if (state !== "unknown") this.cache.set(key, { state, at: now });
    return state;
  }

  /**
   * Ask `gh`, then origin.
   * @param repoPath - The clone.
   * @param branch - The branch.
   * @returns The state.
   */
  private async ask(repoPath: string, branch: string): Promise<MergeState> {
    const gh = await (this.options.gh ?? runGh)(
      ["pr", "view", branch, "--json", "state,mergedAt"],
      repoPath,
    );
    if (gh && gh.code === 0) {
      try {
        const pr = JSON.parse(gh.stdout) as { state?: string };
        if (pr.state === "MERGED") return "merged";
        if (pr.state === "CLOSED") return "closed";
        if (pr.state === "OPEN") return "open";
      } catch {
        // Fall through to origin.
      }
    }
    const heads = await (this.options.git ?? runGit)(
      ["ls-remote", "--heads", "origin", branch],
      { cwd: repoPath, timeoutMs: 30_000 },
    );
    if (heads.code !== 0) return "unknown";
    return heads.stdout.trim() ? "open" : "gone";
  }
}
