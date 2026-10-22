import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "keryx";
import { dashboardSessionUrl } from "../../ops/WorkItemOps";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { settle } from "../linear/sessions";
import {
  delegatedSession,
  itemsOf,
  personSays,
  route,
  sessionById,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, until } from "./helpers";

/**
 * The worktree lifecycle end to end — the real server, finear, the real
 * daemon, the fake agent, and a real (local, bare) origin: a delegation gets
 * a worktree at `~/worktrees/web/ENG-n` on `hypotenuse/eng-n-…`; the agent
 * commits, pushes, and prints a pull request URL, which the session links
 * beside its dashboard link (and someone else's pull request is not linked);
 * a follow-up reuses the worktree; and once the session is complete and the
 * grace is over, cleanup removes the worktree while the pushed branch
 * survives on origin.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill();
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let appUserId: string;
let home: DaemonHome;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "wt-laptop",
    { scenario: "ship" },
  );
  await home.startForeground();
}, HOOK_TIMEOUT);

/**
 * Run git in a directory.
 * @param cwd - Where.
 * @param args - Arguments.
 * @returns Its stdout, trimmed.
 */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" });
  return run.stdout.toString().trim();
}

describe("the worktree lifecycle", () => {
  test("LC-SES-16 LC-SES-12 create, link the pull request, reuse, and clean up", async () => {
    const { session, issue } = await delegatedSession(
      linear,
      appUserId,
      "Fix checkout total rounding",
    );
    const identifier = issue.identifier;
    const lower = identifier.toLowerCase();
    await until(async () => {
      const [item] = await itemsOf(session.id);
      return item?.status === "completed" ? item : null;
    }, 30_000);
    await settle();

    // A worktree per session, on its own branch.
    const dir = join(home.root, "worktrees", "web", identifier);
    const branch = `hypotenuse/${lower}-fix-checkout-total-rounding`;
    expect(existsSync(join(dir, "fix.txt"))).toBe(true);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(
      git(dir, "config", "--worktree", "--get", "hypotenuse.session"),
    ).toBe(String(session.id));
    // The agent's commit says an agent wrote it, through a hook that reached
    // only the agent: the checkout's own config does not point at it.
    expect(git(dir, "log", "-1", "--format=%B")).toContain(
      "Co-Authored-By: Hypotenuse <noreply@hypotenuse.cloud>",
    );
    expect(git(dir, "config", "--get", "core.hooksPath")).toBe("");
    // The agent pushed its branch to origin.
    const origin = join(home.root, "origin.git");
    expect(git(origin, "branch", "--list", branch)).toContain(branch);

    // Linked: the dashboard at claim, the pull request when it was printed;
    // the other repository's pull request was not.
    const mirror = await sessionById(session.id);
    expect(mirror.externalUrls).toEqual([
      { label: "Hypotenuse", url: dashboardSessionUrl(session.id) },
      { label: "Pull Request", url: "https://github.com/acme/web/pull/7" },
    ]);
    const [first] = await itemsOf(session.id);
    expect(first.outcome?.branch).toBe(branch);

    // A follow-up reuses the worktree.
    await personSays(linear, session.externalSessionId, "Anything else?");
    await until(async () => {
      await route();
      const item = (await itemsOf(session.id))[1];
      return item?.status === "completed" ? item : null;
    }, 30_000);
    const list = await home.run(["worktrees", "list", "--json"]);
    expect(list.code).toBe(0);
    const rows = JSON.parse(list.stdout).worktrees as {
      path: string;
      branch: string;
      state: string;
      safeToRemove: boolean;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({
        path: dir,
        branch,
        state: "idle",
        safeToRemove: true,
      }),
    ]);

    // Within cleanup_grace (1h by default) it is kept, and says why.
    const kept = await home.run(["worktrees", "cleanup", "--json"]);
    expect(JSON.parse(kept.stdout).kept).toEqual([
      expect.objectContaining({
        path: dir,
        reason: "not eligible (within cleanup_grace)",
      }),
    ]);

    // With no grace, the next cleanup removes it; the pushed branch survives.
    const config = readFileSync(home.configPath, "utf8");
    writeFileSync(
      home.configPath,
      config.replace("[sessions]\n", '[sessions]\ncleanup_grace = "0s"\n'),
    );
    expect((await home.run(["daemon", "reload", "--json"])).code).toBe(0);
    const removed = await home.run(["worktrees", "cleanup", "--json"]);
    expect(JSON.parse(removed.stdout).removed).toEqual([
      expect.objectContaining({ path: dir, branch }),
    ]);
    expect(existsSync(dir)).toBe(false);
    expect(git(join(home.root, "web"), "worktree", "list")).not.toContain(dir);
    expect(git(origin, "branch", "--list", branch)).toContain(branch);
  }, 120_000);
});
