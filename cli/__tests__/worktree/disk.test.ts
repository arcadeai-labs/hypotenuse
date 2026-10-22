import { expect, test } from "bun:test";
import { WorktreeCleaner } from "../../src/worktree/cleanup";
import { formatBytes, freeBytes } from "../../src/worktree/disk";
import { KeyedMutex } from "../../src/worktree/lock";
import { WorkspaceError } from "../../src/worktree/manager";
import { fixture, request, work } from "./repo";

const GB = 1024 ** 3;

test("freeBytes reads the nearest existing ancestor's volume", () => {
  const seen: string[] = [];
  const free = freeBytes("/tmp/does/not/exist/yet", (path) => {
    seen.push(path);
    return { bavail: 10, bsize: 4096 };
  });
  expect(free).toBe(40_960);
  expect(seen).toEqual(["/tmp"]);
  expect(formatBytes(1.5 * GB)).toBe("1.5GB");
  expect(formatBytes(512 * 1024 ** 2)).toBe("512MB");
});

test("short on disk: cleanup runs first, and if that frees enough the worktree is made", async () => {
  let free = 1 * GB;
  let cleanups = 0;
  const f = fixture({
    manager: {
      statfs: () => ({ bavail: free, bsize: 1 }),
      freeSpace: async () => {
        cleanups++;
        free = 3 * GB;
      },
    },
  });
  const ws = await f.manager.acquire(request(f));
  expect(cleanups).toBe(1);
  expect(ws.mode).toBe("worktree");
});

test("still short after cleanup: the turn fails saying how much is free and how to clean up", async () => {
  let cleanups = 0;
  const f = fixture({
    manager: {
      statfs: () => ({ bavail: 1.2 * GB, bsize: 1 }),
      freeSpace: async () => {
        cleanups++;
      },
    },
  });
  const failure = await f.manager.acquire(request(f)).catch((e) => e);
  expect(cleanups).toBe(1);
  expect(failure).toBeInstanceOf(WorkspaceError);
  expect((failure as WorkspaceError).body).toBe(
    "Runner test-runner has only 1.2GB free on the volume of ~/worktrees; a new worktree needs 2.0GB. Free some space, or run `hypotenuse worktrees cleanup` on that machine.",
  );
  expect(f.manager.diskStatus(f.config)).toEqual({
    free: 1.2 * GB,
    enough: false,
  });
  expect(f.state.worktrees()).toEqual([]);
});

test("the cleanup the disk guard runs takes the repository's mutex without deadlocking", async () => {
  let free = 1 * GB;
  const mutex = new KeyedMutex();
  let cleaner: WorktreeCleaner | null = null;
  const f = fixture({
    manager: {
      mutex,
      statfs: () => ({ bavail: free, bsize: 1 }),
      freeSpace: async () => {
        await cleaner?.run({ all: true });
        free = 3 * GB;
      },
    },
  });
  cleaner = new WorktreeCleaner(f.state, () => f.config, {
    mutex,
    repositories: () => [f.repository],
  });
  // An idle worktree of the same repository for the cleanup to consider.
  free = 5 * GB;
  const older = await f.manager.acquire(request(f));
  await older.release();
  f.state.setSessionState(42, "idle");
  free = 1 * GB;
  const ws = await Promise.race([
    f.manager.acquire(request(f, work({ agentSessionId: 43, workItemId: 2 }))),
    Bun.sleep(10_000).then(() => {
      throw new Error(
        "acquire hung: cleanup is waiting on the mutex acquire holds",
      );
    }),
  ]);
  expect(ws.mode).toBe("worktree");
  // Cleanup removed the idle one, so the new session took its directory.
  expect(f.state.worktree(older.worktreeId as number)).toBeNull();
  expect(ws.cwd).toBe(older.cwd);
});
