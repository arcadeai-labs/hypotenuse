/**
 * `worktrees list`: every live worktree with its size and whether the safety
 * rules would let it be removed now. Shared by the daemon's control socket and
 * the CLI's offline fallback, so both print the same thing.
 */
import type { LocalWorktree, StateDb } from "../daemon/state";
import type { WorktreeCleaner } from "./cleanup";

/** How long `du` gets per worktree before its size is unknown. */
export const SIZE_BUDGET_MS = 2_000;

/** One row of `worktrees list`. */
export interface WorktreeListing {
  id: number;
  kind: LocalWorktree["kind"];
  path: string;
  repository: string;
  branch: string;
  state: LocalWorktree["state"];
  agentSessionId: number | null;
  issueIdentifier: string | null;
  lastUsedAt: number;
  /** Bytes on disk, or null past the time budget. */
  sizeBytes: number | null;
  /** Whether the safety rules allow removing it now (policies aside). */
  safeToRemove: boolean;
  /** Why not, when not. */
  reason: string | null;
  /** The cleanup policy it is under. */
  policy: string;
}

/**
 * A directory's size, from `du -sk`, within a time budget.
 * @param path - The directory.
 * @param budgetMs - The most to wait.
 * @returns Bytes, or null.
 */
export async function directorySize(
  path: string,
  budgetMs = SIZE_BUDGET_MS,
): Promise<number | null> {
  try {
    const proc = Bun.spawn(["du", "-sk", path], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), budgetMs);
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) return null;
    const kb = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Describe every live worktree.
 * @param state - The state database.
 * @param cleaner - For the safety rules and policies.
 * @param options - Whether to measure sizes.
 * @returns The rows, most recently used first.
 */
export async function listWorktrees(
  state: StateDb,
  cleaner: WorktreeCleaner,
  options: { sizes?: boolean } = {},
): Promise<WorktreeListing[]> {
  await cleaner.adopt();
  const rows: WorktreeListing[] = [];
  for (const wt of state.worktrees({ live: true })) {
    const safety = await cleaner.safety(wt);
    rows.push({
      id: wt.id,
      kind: wt.kind,
      path: wt.path,
      repository: wt.repository,
      branch: wt.branch,
      state: wt.state,
      agentSessionId: wt.agentSessionId,
      issueIdentifier:
        wt.agentSessionId !== null
          ? (state.session(wt.agentSessionId)?.issueIdentifier ?? null)
          : null,
      lastUsedAt: wt.lastUsedAt,
      sizeBytes: options.sizes === false ? null : await directorySize(wt.path),
      safeToRemove: safety.reason === null,
      reason: safety.reason,
      policy: cleaner.policyOf(wt),
    });
  }
  return rows;
}
