import { expect, test } from "bun:test";
import { formatBytes, freeBytes } from "../../src/worktree/disk";
import { WorkspaceError } from "../../src/worktree/manager";
import { fixture, request } from "./repo";

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
