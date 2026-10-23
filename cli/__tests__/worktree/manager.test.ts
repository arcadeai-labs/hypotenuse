import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  branchName,
  issueDirectory,
  SLUG_MAX,
  slugify,
} from "../../src/worktree/branch";
import { WorkspaceError } from "../../src/worktree/manager";
import { assignment } from "../acp/harness";
import { commit, fixture, git, request, work } from "./repo";

describe("branch names", () => {
  test.each([
    ["Fix checkout total rounding", "fix-checkout-total-rounding"],
    ["Café crème brûlée — naïve façade", "cafe-creme-brulee-naive-facade"],
    ["Straße & Ærø", "strasse-aero"],
    ["  [BUG] 500 on /api/v2/orders?id=1  ", "bug-500-on-api-v2-orders-id-1"],
    ["日本語のタイトル", ""],
    [
      "Make the checkout page remember the shipping address between visits",
      "make-the-checkout-page-remember-the",
    ],
    ["a".repeat(60), "a".repeat(SLUG_MAX)],
  ])("slugify(%p) is %p", (title, slug) => {
    expect(slugify(title)).toBe(slug);
    expect(slugify(title).length).toBeLessThanOrEqual(SLUG_MAX);
  });

  test("a branch is <prefix>/<issue>-<slug>, and an empty slug drops the dash", () => {
    expect(
      branchName("hypotenuse", "ENG-123", "Fix checkout total rounding", "s"),
    ).toBe("hypotenuse/eng-123-fix-checkout-total-rounding");
    expect(branchName("bots/", "ENG-9", "日本語", "s")).toBe("bots/eng-9");
    expect(branchName("hypotenuse", null, null, "session-7")).toBe(
      "hypotenuse/session-7",
    );
    expect(issueDirectory("ENG-123", "x")).toBe("ENG-123");
    expect(issueDirectory(null, "session-7")).toBe("session-7");
  });
});

describe("acquire", () => {
  test("creates <root>/<repo>/<ISSUE> on <prefix>/<issue>-<slug> from origin/<base>, marked for git", async () => {
    const f = fixture();
    const ws = await f.manager.acquire(request(f));
    expect(ws.mode).toBe("worktree");
    expect(ws.cwd).toBe(join(f.root, "worktrees", "web", "ENG-1"));
    expect(ws.branch).toBe("hypotenuse/eng-1-fix-checkout-rounding");
    expect(ws.reused).toBe(false);
    expect(git(ws.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      ws.branch as string,
    );
    expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(
      git(f.origin, "rev-parse", "main"),
    );
    expect(
      git(ws.cwd, "config", "--worktree", "--get", "hypotenuse.session"),
    ).toBe("42");
    expect(
      git(ws.cwd, "config", "--worktree", "--get", "hypotenuse.issue"),
    ).toBe("ENG-1");
    const row = f.state.worktree(ws.worktreeId as number);
    expect(row?.state).toBe("active");
    expect(f.state.session(42)?.worktreeId).toBe(row?.id ?? -1);
    await ws.release();
    expect(f.state.worktree(row?.id as number)?.state).toBe("idle");
  });

  test("starts from a fresh fetch: a commit pushed after the clone is in the worktree", async () => {
    const f = fixture();
    const other = join(f.root, "other");
    git(f.root, "clone", "-q", f.origin, other);
    commit(other, "new.txt");
    git(other, "push", "-q", "origin", "main");
    const ws = await f.manager.acquire(request(f));
    expect(existsSync(join(ws.cwd, "new.txt"))).toBe(true);
  });

  test("a follow-up reuses the worktree, uncommitted work and all", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    Bun.write(join(first.cwd, "wip.txt"), "half done\n");
    await first.release();
    const second = await f.manager.acquire(
      request(f, work({ workItemId: 2, kind: "prompt", fresh: false })),
    );
    expect(second.reused).toBe(true);
    expect(second.cwd).toBe(first.cwd);
    expect(second.worktreeId).toBe(first.worktreeId);
    expect(existsSync(join(second.cwd, "wip.txt"))).toBe(true);
  });

  test("a worktree the daemon made but never recorded (killed mid-acquire) is found and reused", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    await first.release();
    Bun.write(join(first.cwd, "wip.txt"), "half done\n");
    // What a kill -9 between `git worktree add` and the insert leaves: git
    // has the worktree and the branch's owner, state.db has neither.
    const sessionId = work().agentSessionId;
    f.state.linkWorktree(sessionId, null);
    f.state.db.exec("DELETE FROM worktrees");

    const second = await f.manager.acquire(
      request(f, work({ workItemId: 2, kind: "prompt", fresh: false })),
    );
    expect(second.reused).toBe(true);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branch).toBe(first.branch);
    expect(existsSync(join(second.cwd, "wip.txt"))).toBe(true);
    expect(f.state.session(sessionId)?.worktreeId).toBe(second.worktreeId);
  });

  test("a lost worktree cleanup already adopted is linked, not recorded twice", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    await first.release();
    const sessionId = work().agentSessionId;
    f.state.linkWorktree(sessionId, null);
    const second = await f.manager.acquire(request(f, work({ workItemId: 2 })));
    expect(second.reused).toBe(true);
    expect(second.worktreeId).toBe(first.worktreeId);
    expect(
      f.state.worktrees().filter((w) => w.path === first.cwd),
    ).toHaveLength(1);
  });

  test("another session's lost worktree is never taken", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    await first.release();
    f.state.linkWorktree(work().agentSessionId, null);
    f.state.db.exec("DELETE FROM worktrees");
    const other = await f.manager.acquire(
      request(f, work({ agentSessionId: 99, workItemId: 3 })),
    );
    expect(other.cwd).not.toBe(first.cwd);
    expect(other.branch).not.toBe(first.branch);
  });

  test("a worktree whose HEAD moved off its branch is not reused", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    await first.release();
    git(first.cwd, "switch", "-q", "--detach");
    const second = await f.manager.acquire(request(f, work({ workItemId: 2 })));
    expect(second.reused).toBe(false);
    expect(second.cwd).toBe(`${first.cwd}-2`);
    // Its own branch is still the session's, so it is used again.
    expect(second.branch).toBe(first.branch);
  });

  test("an existing branch that belongs to nothing known gets a numeric suffix", async () => {
    const f = fixture();
    const other = join(f.root, "other");
    git(f.root, "clone", "-q", f.origin, other);
    git(other, "switch", "-q", "-c", "hypotenuse/eng-1-fix-checkout-rounding");
    git(other, "push", "-q", "origin", "HEAD");
    git(f.clone, "branch", "hypotenuse/eng-1-fix-checkout-rounding-2");
    const ws = await f.manager.acquire(request(f));
    expect(ws.branch).toBe("hypotenuse/eng-1-fix-checkout-rounding-3");
  });

  test("a second session on the same issue gets <ISSUE>-2 and its own branch", async () => {
    const f = fixture();
    const first = await f.manager.acquire(request(f));
    const second = await f.manager.acquire(
      request(f, work({ agentSessionId: 43, workItemId: 2 })),
    );
    expect(second.cwd).toBe(join(f.root, "worktrees", "web", "ENG-1-2"));
    expect(second.branch).toBe(`${first.branch}-2`);
  });

  test("two concurrent acquires on one repository both succeed (the mutex)", async () => {
    const f = fixture();
    const issue = (n: number) => ({
      ...work().issue,
      identifier: `ENG-${n}`,
      title: `Issue ${n}`,
    });
    const results = await Promise.all(
      [10, 11, 12].map((n) =>
        f.manager.acquire(
          request(
            f,
            work({ agentSessionId: n, workItemId: n, issue: issue(n) }),
          ),
        ),
      ),
    );
    expect(results.map((w) => w.branch).sort()).toEqual([
      "hypotenuse/eng-10-issue-10",
      "hypotenuse/eng-11-issue-11",
      "hypotenuse/eng-12-issue-12",
    ]);
    const listed = git(f.clone, "worktree", "list", "--porcelain");
    for (const w of results) expect(listed).toContain(w.cwd);
  });

  test("the branch prefix comes from the repository", async () => {
    const f = fixture({ repo: 'branch_prefix = "bots"' });
    const ws = await f.manager.acquire(request(f));
    expect(ws.branch).toBe("bots/eng-1-fix-checkout-rounding");
  });

  test("a turn with no repository gets a scratch directory", async () => {
    const f = fixture();
    const ws = await f.manager.acquire(
      request(f, assignment({ role: "manager" })),
    );
    expect(ws.mode).toBe("scratch");
    expect(ws.cwd).toBe(join(f.root, "worktrees", "_scratch", "42"));
    expect(existsSync(ws.cwd)).toBe(true);
    expect(ws.branch).toBeNull();
    await ws.release();
    const again = await f.manager.acquire(
      request(f, assignment({ role: "manager" })),
    );
    expect(again.worktreeId).toBe(ws.worktreeId);
  });

  test("a repository this runner does not have fails the turn", async () => {
    const f = fixture();
    const a = work({
      repository: { remote: "github.com/acme/api", baseBranch: null },
    });
    await expect(f.manager.acquire(request(f, a))).rejects.toBeInstanceOf(
      WorkspaceError,
    );
  });
});

describe("a manager's read-only checkout", () => {
  test("is detached at the fresh base branch, creates no branch, and is removed when the turn ends", async () => {
    const f = fixture();
    const branchesBefore = git(f.clone, "branch", "--format=%(refname)");
    const ws = await f.manager.acquire(request(f, work({ role: "manager" })));
    expect(ws.mode).toBe("readonly");
    expect(ws.branch).toBeNull();
    expect(ws.baseBranch).toBe("main");
    expect(ws.cwd).toBe(join(f.root, "worktrees", "web", "ENG-1"));
    expect(git(ws.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(
      git(f.origin, "rev-parse", "main"),
    );
    expect(git(f.clone, "branch", "--format=%(refname)")).toBe(branchesBefore);
    await ws.release();
    expect(existsSync(ws.cwd)).toBe(false);
    expect(f.state.worktree(ws.worktreeId as number)?.state).toBe("removed");
    expect(git(f.clone, "worktree", "list")).not.toContain(ws.cwd);
  });

  test("a dirty one is kept for cleanup's safety rules, and the next turn gets a fresh one", async () => {
    const f = fixture();
    const first = await f.manager.acquire(
      request(f, work({ role: "manager" })),
    );
    Bun.write(join(first.cwd, "scribble.txt"), "should not be here\n");
    git(first.cwd, "add", "scribble.txt");
    await first.release();
    expect(existsSync(join(first.cwd, "scribble.txt"))).toBe(true);
    expect(f.state.worktree(first.worktreeId as number)?.state).toBe("idle");
    const second = await f.manager.acquire(
      request(f, work({ role: "manager", workItemId: 2, kind: "review" })),
    );
    expect(second.reused).toBe(false);
    expect(second.cwd).toBe(`${first.cwd}-2`);
    await second.release();
  });

  test("without a repository, a manager works in a scratch directory", async () => {
    const f = fixture();
    const ws = await f.manager.acquire(
      request(f, work({ role: "manager", repository: null })),
    );
    expect(ws.mode).toBe("scratch");
  });
});
