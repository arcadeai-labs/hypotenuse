import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "../../src/worktree/manager";
import { fixture, git, request, work } from "./repo";

const never = { repo: 'worktrees = "never"' };

test("the agent works in the checkout itself, on its own branch, under a lock; release switches back", async () => {
  const f = fixture(never);
  const ws = await f.manager.acquire(request(f));
  expect(ws.mode).toBe("checkout");
  expect(ws.cwd).toBe(f.clone);
  expect(ws.branch).toBe("hypotenuse/eng-1-fix-checkout-rounding");
  expect(git(f.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    ws.branch as string,
  );
  const lock = join(f.clone, ".git", "hypotenuse.lock");
  expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({
    pid: process.pid,
    agentSessionId: 42,
  });
  expect(f.state.worktrees()).toEqual([]);
  await ws.release();
  expect(git(f.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(lock)).toBe(false);
});

test("a dirty checkout is refused and left exactly as it was", async () => {
  const f = fixture(never);
  writeFileSync(join(f.clone, "README.md"), "# mine, unsaved\n");
  writeFileSync(join(f.clone, "notes.txt"), "scratch\n");
  const failure = await f.manager.acquire(request(f)).catch((e) => e);
  expect(failure).toBeInstanceOf(WorkspaceError);
  expect((failure as WorkspaceError).body).toMatch(
    /^~\/web has uncommitted changes, .* Hypotenuse never stashes, resets, or cleans a person's checkout/,
  );
  expect(readFileSync(join(f.clone, "README.md"), "utf8")).toBe(
    "# mine, unsaved\n",
  );
  expect(readFileSync(join(f.clone, "notes.txt"), "utf8")).toBe("scratch\n");
  expect(git(f.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(f.clone, "stash", "list")).toBe("");
  expect(existsSync(join(f.clone, ".git", "hypotenuse.lock"))).toBe(false);
});

test("work the agent left uncommitted stays on its branch, and the session's next turn continues there", async () => {
  const f = fixture(never);
  const first = await f.manager.acquire(request(f));
  writeFileSync(join(f.clone, "wip.txt"), "half done\n");
  await first.release();
  expect(git(f.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    first.branch as string,
  );
  const second = await f.manager.acquire(request(f, work({ workItemId: 2 })));
  expect(second.branch).toBe(first.branch);
  expect(readFileSync(join(f.clone, "wip.txt"), "utf8")).toBe("half done\n");
});

test("one session at a time: the second waits, says so, and starts when the first is done", async () => {
  const f = fixture(never);
  const first = await f.manager.acquire(request(f));
  let started = false;
  const second = f.manager
    .acquire(
      request(
        f,
        work({
          agentSessionId: 43,
          workItemId: 2,
          issue: { ...work().issue, identifier: "ENG-2", title: "Other" },
        }),
      ),
    )
    .then((ws) => {
      started = true;
      return ws;
    });
  await Bun.sleep(300);
  expect(started).toBe(false);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "thought",
      body: expect.stringMatching(
        /^Waiting for another session to finish in web/,
      ),
    }),
  );
  await first.release();
  const ws = await second;
  expect(ws.branch).toBe("hypotenuse/eng-2-other");
  await ws.release();
});

test("a stop while waiting for the checkout ends the wait", async () => {
  const f = fixture(never);
  await f.manager.acquire(request(f));
  const controller = new AbortController();
  const waiting = f.manager
    .acquire(
      request(
        f,
        work({ agentSessionId: 43, workItemId: 2 }),
        controller.signal,
      ),
    )
    .catch((e) => e);
  await Bun.sleep(100);
  controller.abort("stop");
  expect(((await waiting) as WorkspaceError).body).toBe("stopped");
});
