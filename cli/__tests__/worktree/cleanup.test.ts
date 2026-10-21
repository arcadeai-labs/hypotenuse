import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDb } from "../../src/daemon/state";
import { KEEP_FILE, WorktreeCleaner } from "../../src/worktree/cleanup";
import type { Workspace } from "../../src/worktree/manager";
import { MergeStateChecker } from "../../src/worktree/merge-state";
import { assignment } from "../acp/harness";
import { commit, type Fixture, fixture, git, request } from "./repo";

const HOUR = 3_600_000;

/**
 * A finished session's worktree: acquired, released, its turn answered.
 * @param f - The fixture.
 * @param answer - How the turn answered.
 * @returns The workspace.
 */
async function finished(f: Fixture, answer = "response"): Promise<Workspace> {
  const ws = await f.manager.acquire(request(f));
  await ws.release();
  f.state.setSessionState(42, "idle");
  f.state.recordTurnEnd(42, answer);
  return ws;
}

/**
 * A cleaner over a fixture.
 * @param f - The fixture.
 * @param options - The clock and the merge checker.
 * @returns The cleaner.
 */
function cleaner(
  f: Fixture,
  options: { now?: () => number; mergeState?: MergeStateChecker } = {},
): WorktreeCleaner {
  return new WorktreeCleaner(f.state, () => f.config, {
    mutex: f.manager.mutex,
    repositories: () => [f.repository],
    ...options,
  });
}

const grace0 = { extra: 'cleanup_grace = "0s"' };

describe("on-complete", () => {
  test("a completed, clean, pushed worktree is removed, its branch deleted with -d, and the row kept as history", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    const report = await cleaner(f).run();
    expect(report.removed).toEqual([
      {
        path: ws.cwd,
        repository: "web",
        branch: ws.branch as string,
        branchDeleted: true,
        discarded: [],
      },
    ]);
    expect(existsSync(ws.cwd)).toBe(false);
    expect(git(f.clone, "worktree", "list")).not.toContain(ws.cwd);
    expect(git(f.clone, "branch", "--list", ws.branch as string)).toBe("");
    expect(f.state.worktree(ws.worktreeId as number)?.state).toBe("removed");
    expect(f.state.session(42)?.worktreeId).toBe(ws.worktreeId);
  });

  test("waits for cleanup_grace after the turn ends", async () => {
    const f = fixture();
    await finished(f);
    const soon = await cleaner(f).run();
    expect(soon.kept[0]?.reason).toBe("not eligible (within cleanup_grace)");
    const later = await cleaner(f, { now: () => Date.now() + 2 * HOUR }).run();
    expect(later.removed).toHaveLength(1);
  });

  test("a session awaiting input, or one that failed, is not complete", async () => {
    const f = fixture(grace0);
    await finished(f, "elicitation");
    expect((await cleaner(f).run()).kept[0]?.reason).toBe(
      "not eligible (session awaiting input)",
    );
    f.state.recordTurnEnd(42, "error");
    expect((await cleaner(f).run()).kept[0]?.reason).toBe(
      "not eligible (session not complete)",
    );
  });
});

describe("safety rules", () => {
  test("1: a worktree a turn is using is kept, even with --force", async () => {
    const f = fixture(grace0);
    const ws = await f.manager.acquire(request(f));
    const report = await cleaner(f).run({ all: true, force: true });
    expect(report.kept).toEqual([
      {
        path: ws.cwd,
        repository: "web",
        branch: ws.branch as string,
        reason: "in use",
      },
    ]);
    expect(existsSync(ws.cwd)).toBe(true);
  });

  test("2: uncommitted changes keep it; --force discards them and says so", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    writeFileSync(join(ws.cwd, "README.md"), "edited\n");
    expect((await cleaner(f).run()).kept[0]?.reason).toBe(
      "uncommitted changes",
    );
    expect(existsSync(ws.cwd)).toBe(true);
    const forced = await cleaner(f).run({ force: true });
    expect(forced.removed[0]?.discarded).toEqual(["uncommitted changes"]);
    expect(existsSync(ws.cwd)).toBe(false);
  });

  test("3: unpushed commits keep it; --force removes the worktree but -d never deletes the branch", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    commit(ws.cwd, "feature.txt");
    expect((await cleaner(f).run()).kept[0]?.reason).toBe("unpushed commits");
    const forced = await cleaner(f).run({ force: true });
    expect(forced.removed[0]).toMatchObject({
      branchDeleted: false,
      discarded: ["unpushed commits"],
    });
    expect(git(f.clone, "branch", "--list", ws.branch as string)).toContain(
      ws.branch as string,
    );
  });

  test("pushed commits are safe: the worktree goes and the branch survives on origin", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    commit(ws.cwd, "feature.txt");
    git(ws.cwd, "push", "-q", "-u", "origin", ws.branch as string);
    const report = await cleaner(f).run();
    expect(report.removed).toHaveLength(1);
    expect(git(f.origin, "branch", "--list", ws.branch as string)).toContain(
      ws.branch as string,
    );
  });

  test("4: a .hypotenuse-keep file keeps it, and is not mistaken for a change", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    writeFileSync(join(ws.cwd, KEEP_FILE), "");
    expect((await cleaner(f).run()).kept[0]?.reason).toBe("kept by request");
  });
});

describe("policies", () => {
  test("ttl: removed once unused for cleanup_ttl", async () => {
    const f = fixture({ extra: 'cleanup = "ttl"\ncleanup_ttl = "7d"' });
    await finished(f);
    expect((await cleaner(f).run()).kept[0]?.reason).toBe(
      "not eligible (within cleanup_ttl)",
    );
    const later = cleaner(f, { now: () => Date.now() + 8 * 24 * HOUR });
    expect((await later.run()).removed).toHaveLength(1);
  });

  test("on-merge: gh's MERGED or CLOSED, or the branch gone from origin; an open pull request keeps it", async () => {
    const f = fixture({ repo: 'cleanup = "on-merge"' });
    const ws = await finished(f);
    git(ws.cwd, "push", "-q", "origin", ws.branch as string);
    let prState = "OPEN";
    const checker = () =>
      new MergeStateChecker({
        gh: async () => ({
          code: 0,
          stdout: JSON.stringify({ state: prState }),
        }),
      });
    expect(
      (await cleaner(f, { mergeState: checker() }).run()).kept[0]?.reason,
    ).toBe("not eligible (pull request not merged)");
    prState = "MERGED";
    expect(
      (await cleaner(f, { mergeState: checker() }).run()).removed,
    ).toHaveLength(1);
  });

  test("on-merge without gh asks origin: a branch still there is open, a deleted one counts as merged", async () => {
    const f = fixture({ repo: 'cleanup = "on-merge"' });
    const ws = await finished(f);
    git(ws.cwd, "push", "-q", "origin", ws.branch as string);
    const noGh = () => new MergeStateChecker({ gh: async () => null });
    expect(
      (await cleaner(f, { mergeState: noGh() }).run()).kept[0]?.reason,
    ).toBe("not eligible (pull request not merged)");
    git(f.origin, "branch", "-D", ws.branch as string);
    expect(
      (await cleaner(f, { mergeState: noGh() }).run()).removed,
    ).toHaveLength(1);
  });

  test("the merge check caches each answer for ten minutes", async () => {
    let calls = 0;
    let now = 0;
    const checker = new MergeStateChecker({
      gh: async () => {
        calls++;
        return { code: 0, stdout: '{"state":"OPEN"}' };
      },
      now: () => now,
    });
    await checker.check("/r", "b");
    await checker.check("/r", "b");
    expect(calls).toBe(1);
    now = 11 * 60_000;
    await checker.check("/r", "b");
    expect(calls).toBe(2);
  });

  test("never: only --all or --older-than", async () => {
    const f = fixture({ extra: 'cleanup = "never"' });
    await finished(f);
    expect((await cleaner(f).run()).kept[0]?.reason).toBe(
      "not eligible (cleanup = never)",
    );
    expect(
      (await cleaner(f).run({ olderThanMs: 14 * 24 * HOUR })).kept[0]?.reason,
    ).toBe("not eligible (used too recently)");
    const dry = await cleaner(f).run({ all: true, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toHaveLength(1);
    expect(f.state.worktrees({ live: true })).toHaveLength(1);
    expect((await cleaner(f).run({ all: true })).removed).toHaveLength(1);
  });

  test("a repository's cleanup overrides [sessions] cleanup", async () => {
    const f = fixture({
      extra: 'cleanup = "never"\ncleanup_grace = "0s"',
      repo: 'cleanup = "on-complete"',
    });
    await finished(f);
    expect((await cleaner(f).run()).removed).toHaveLength(1);
  });
});

describe("what state.db does not know", () => {
  test("a worktree git knows by its hypotenuse.session key is adopted and cleaned up", async () => {
    const f = fixture();
    const ws = await finished(f);
    const fresh = new StateDb(":memory:");
    const c = new WorktreeCleaner(fresh, () => f.config, {
      repositories: () => [f.repository],
    });
    expect(await c.adopt()).toBe(1);
    expect(fresh.worktrees()[0]).toMatchObject({
      path: ws.cwd,
      branch: ws.branch,
      agentSessionId: 42,
      state: "idle",
    });
    expect((await c.run({ all: true })).removed).toHaveLength(1);
    expect(existsSync(ws.cwd)).toBe(false);
  });

  test("a worktree removed by hand is forgotten; a scratch directory is removed", async () => {
    const f = fixture(grace0);
    const ws = await finished(f);
    git(f.clone, "worktree", "remove", "--force", ws.cwd);
    await cleaner(f).run();
    expect(f.state.worktree(ws.worktreeId as number)?.state).toBe("removed");

    const scratch = await f.manager.acquire(
      request(f, assignment({ agentSessionId: 50 })),
    );
    await scratch.release();
    f.state.setSessionState(50, "idle");
    const report = await cleaner(f).run({ all: true });
    expect(report.removed.map((r) => r.path)).toContain(scratch.cwd);
    expect(existsSync(scratch.cwd)).toBe(false);
  });
});
