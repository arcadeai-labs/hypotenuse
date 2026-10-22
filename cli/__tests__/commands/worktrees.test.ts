import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDb } from "../../src/daemon/state";
import { WorktreeManager } from "../../src/worktree/manager";
import { FAKE_AGENT } from "../acp/harness";
import { fixture, request } from "../worktree/repo";

/**
 * `hypotenuse worktrees list|cleanup` with no daemon running: they read
 * `state.db` and scan the worktree root themselves, and say so.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/**
 * Run the CLI in a fixture's home.
 * @param root - The home.
 * @param args - Its arguments.
 * @returns Code and output.
 */
async function run(root: string, args: string[]) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      CLI,
      "-c",
      join(root, "hyp.toml"),
      "--state-dir",
      join(root, "state"),
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, ".config"),
        XDG_STATE_HOME: join(root, ".state"),
        HYPOTENUSE_NO_UPDATE_CHECK: "1",
        HYPOTENUSE_CONFIG: undefined,
        NO_COLOR: "1",
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

test("list and cleanup work from state.db when the daemon is not running", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "hyp.toml"),
    [
      "config_version = 1",
      "[agents.fake]",
      `command = ["bun", "${FAKE_AGENT}"]`,
      "[roles.worker]",
      'agent = "fake"',
      "[[repositories]]",
      'path = "~/web"',
      'base_branch = "main"',
      "[sessions]",
      'worktree_root = "~/worktrees"',
      'min_free_disk = "1MB"',
    ].join("\n"),
  );
  const state = new StateDb(join(f.root, "state", "state.db"));
  const manager = new WorktreeManager(state, { env: { HOME: f.root } });
  const ws = await manager.acquire({ ...request({ ...f, state }) });
  await ws.release();
  state.setSessionState(42, "idle");
  state.close();

  const listed = await run(f.root, ["worktrees", "list", "--json"]);
  expect(listed.code).toBe(0);
  const rows = JSON.parse(listed.stdout).worktrees;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    path: ws.cwd,
    repository: "web",
    branch: ws.branch,
    issueIdentifier: "ENG-1",
    state: "idle",
    safeToRemove: true,
    reason: null,
    policy: "on-complete",
  });
  expect(rows[0].sizeBytes).toBeGreaterThan(0);

  const human = await run(f.root, ["worktrees", "list"]);
  expect(human.stdout).toContain("~/worktrees/web/ENG-1");
  expect(human.stdout).toContain("yes");

  const kept = await run(f.root, ["worktrees", "cleanup"]);
  expect(kept.code).toBe(0);
  expect(kept.stdout).toContain(
    "Kept ~/worktrees/web/ENG-1: not eligible (session not complete)",
  );

  const dry = await run(f.root, ["worktrees", "cleanup", "--all", "--dry-run"]);
  expect(dry.stdout).toContain("Would remove ~/worktrees/web/ENG-1");
  expect(existsSync(ws.cwd)).toBe(true);

  const removed = await run(f.root, [
    "worktrees",
    "cleanup",
    "--all",
    "--json",
  ]);
  expect(JSON.parse(removed.stdout).removed[0]).toMatchObject({
    path: ws.cwd,
    branchDeleted: true,
  });
  expect(existsSync(ws.cwd)).toBe(false);

  const bad = await run(f.root, [
    "worktrees",
    "cleanup",
    "--older-than",
    "soon",
  ]);
  expect(bad.code).toBe(2);
});
