import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "../../src/worktree/manager";
import { runSetupCommand } from "../../src/worktree/setup";
import { fixture, request, work } from "./repo";

test("setup commands run in order in the new worktree, with the per-session environment, as actions", async () => {
  const f = fixture({
    repo: 'setup = ["echo one > setup.log", "env | grep ^HYPOTENUSE_ | sort >> setup.log"]',
  });
  const ws = await f.manager.acquire(request(f));
  const log = readFileSync(join(ws.cwd, "setup.log"), "utf8");
  expect(log).toContain("one");
  expect(log).toContain("HYPOTENUSE_SESSION_ID=42");
  expect(log).toContain(`HYPOTENUSE_BRANCH=${ws.branch}`);
  expect(log).toContain("HYPOTENUSE_ISSUE=ENG-1");
  const actions = f.events.filter((e) => e.type === "action");
  expect(actions.map((e) => [e.action, e.parameter, e.ephemeral])).toEqual([
    ["Running setup", "echo one > setup.log", true],
    ["Ran setup", "echo one > setup.log", false],
    ["Running setup", "env | grep ^HYPOTENUSE_ | sort >> setup.log", true],
    ["Ran setup", "env | grep ^HYPOTENUSE_ | sort >> setup.log", false],
  ]);
  expect(f.log).toContain("setup: $ echo one > setup.log");
  // A follow-up does not run setup again.
  await ws.release();
  f.events.length = 0;
  await f.manager.acquire(request(f, work({ workItemId: 2 })));
  expect(f.events.filter((e) => e.type === "action")).toEqual([]);
});

test("a failing command fails the turn quoting its output, keeps the worktree, and runs again next turn", async () => {
  const f = fixture({
    repo: 'setup = ["echo installing; echo broken >&2; exit 3", "touch never-ran"]',
  });
  const failure = await f.manager.acquire(request(f)).catch((e) => e);
  expect(failure).toBeInstanceOf(WorkspaceError);
  const body = (failure as WorkspaceError).body;
  expect(body).toMatch(
    /^Setup command `echo installing; echo broken >&2; exit 3` exited with code 3\./,
  );
  expect(body).toContain("kept for inspection at `~/worktrees/web/ENG-1`");
  expect(body).toContain("installing\nbroken");
  const dir = join(f.root, "worktrees", "web", "ENG-1");
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(join(dir, "never-ran"))).toBe(false);
  expect(f.state.worktrees()[0]).toMatchObject({
    state: "idle",
    setupDone: false,
  });
  expect(f.log).toContain("setup: broken");
  f.events.length = 0;
  await f.manager.acquire(request(f, work({ workItemId: 2 }))).catch(() => {});
  expect(
    f.events.some((e) => e.type === "action" && e.action === "Running setup"),
  ).toBe(true);
});

test("a command's stdout and stderr reach the output and the tail in the order they were written", async () => {
  const lines: string[] = [];
  const result = await runSetupCommand(
    "for i in 1 2 3 4 5 6 7 8; do echo out$i; echo err$i >&2; done",
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      emit: () => {},
      output: (line) => lines.push(line),
    },
  );
  const expected = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [
    `out${i}`,
    `err${i}`,
  ]);
  expect(result.code).toBe(0);
  expect(lines).toEqual(expected);
  expect(result.tail).toBe(expected.join("\n"));
});

test("a command past setup_timeout is killed and fails the turn", async () => {
  const f = fixture({ repo: 'setup = ["sleep 30"]\nsetup_timeout = "300ms"' });
  const started = Date.now();
  const failure = await f.manager.acquire(request(f)).catch((e) => e);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect((failure as WorkspaceError).body).toMatch(
    /^Setup command `sleep 30` timed out after 300ms/,
  );
  const done = f.events.find((e) => e.type === "action" && !e.ephemeral);
  expect(done).toMatchObject({ action: "Setup failed", parameter: "sleep 30" });
});

test("a stop during setup kills the command and says nothing about it", async () => {
  const f = fixture({ repo: 'setup = ["sleep 30"]' });
  const controller = new AbortController();
  const pending = f.manager
    .acquire(request(f, work(), controller.signal))
    .catch((e) => e);
  await Bun.sleep(300);
  controller.abort("stop");
  const failure = await pending;
  expect((failure as WorkspaceError).body).toBe("stopped");
  expect(f.events.filter((e) => e.type === "action" && !e.ephemeral)).toEqual(
    [],
  );
});
