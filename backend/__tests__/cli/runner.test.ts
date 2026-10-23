import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import {
  buildTestUniverse,
  cliSignIn,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse runner`, spawned from source against the booted server: a person
 * registers this machine, the first heartbeat lands, and the fleet is listed,
 * viewed, and revoked from the terminal.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let universe: TestUniverse;
let url: string;
/** Each signed-in person's own config directory. */
const homes: Record<string, string> = {};

/**
 * Sign a test user's CLI in through the real approve → exchange flow and
 * write the credentials file `login` would have, with the shared project
 * selected (or none).
 * @param user - Who to sign in.
 * @param project - The selected project; null for none.
 * @returns Their config directory.
 */
async function signIn(
  user: TestUser,
  project: number | null = universe.projectId,
): Promise<string> {
  const { token, cliTokenId } = await cliSignIn(url, user, `${user.name}-pc`);
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-runner-"));
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    credentialsFile(home),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: { token, cliTokenId, device: `${user.name}-pc` },
          project,
          runner: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  return home;
}

/**
 * The credentials file under a config directory.
 * @param home - The config directory.
 * @returns Its path.
 */
function credentialsFile(home: string): string {
  return join(home, "hypotenuse", "credentials.json");
}

/**
 * The runner slot of someone's credentials file.
 * @param who - Whose.
 * @returns The slot.
 */
function runnerSlot(who: string) {
  const file = JSON.parse(readFileSync(credentialsFile(homes[who]!), "utf8"));
  return file.servers[url].runner as {
    runnerId: number;
    projectId: number;
    name: string;
    token: string;
  } | null;
}

/**
 * Run the CLI to completion as someone.
 * @param who - Whose sign-in.
 * @param args - Arguments after `hypotenuse`.
 * @returns Exit code and captured output.
 */
async function run(who: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: homes[who],
      BROWSER: "none",
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_URL: undefined,
      HYPOTENUSE_PROJECT: undefined,
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Read a runner over HTTP as a person, the way the dashboard does.
 * @param user - Who asks.
 * @param id - The runner.
 * @returns The serialized runner.
 */
async function viewRunner(user: TestUser, id: number) {
  const res = await fetch(
    `${url}/api/runner/${id}?projectId=${universe.projectId}`,
    { headers: cookieHeader(user.sessionId) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { runner: Record<string, unknown> }).runner;
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  homes.mario = await signIn(universe.mario);
  homes.toad = await signIn(universe.toad);
  homes.bowser = await signIn(universe.bowser, null);
  homes.unselected = await signIn(universe.mario, null);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("with no project selected", () => {
  test("a person in exactly one project gets that one", async () => {
    const view = await run("bowser", ["--json", "project", "view"]);
    expect(view.code, view.stderr).toBe(0);
    expect(JSON.parse(view.stdout).project.id).toBe(universe.bowser.projectId);
  });

  test("a person in several is asked to choose", async () => {
    const result = await run("unselected", ["runner", "list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "No project selected, and you are in several.",
    );
  });
});

describe("hypotenuse runner", () => {
  let runnerId: number;

  test("register saves the token 0600, never prints it, and the first heartbeat lands", async () => {
    const result = await run("mario", [
      "runner",
      "register",
      "--name",
      "ci-box",
    ]);
    expect(result.code, result.stderr).toBe(0);

    const slot = runnerSlot("mario");
    expect(slot).not.toBeNull();
    runnerId = slot!.runnerId;
    expect(slot!.name).toBe("ci-box");
    expect(slot!.projectId).toBe(universe.projectId);
    expect(slot!.token).toMatch(/^hyp_rt_[A-Za-z0-9_-]{43}$/);
    expect(statSync(credentialsFile(homes.mario!)).mode & 0o777).toBe(0o600);

    expect(result.stdout).toContain(`#${runnerId}`);
    expect(result.stdout + result.stderr).not.toContain(slot!.token);

    const runner = await viewRunner(universe.mario, runnerId);
    expect(runner.status).toBe("online");
    expect(runner.lastHeartbeatAt).toEqual(expect.any(Number));
    expect(runner.platform).toBe(`${process.platform}-${process.arch}`);
  });

  test("a second runner on a live machine registers, then its heartbeat is refused loudly", async () => {
    const result = await run("toad", [
      "--json",
      "runner",
      "register",
      "--name",
      "toad-box",
    ]);
    // One daemon per machine: Mario's runner is live on this same machine, so
    // the first heartbeat is refused — loudly, with the runner still saved.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("first heartbeat failed");
    expect(result.stderr).toContain("ci-box");
    expect(result.stdout).not.toContain("hyp_rt_");
    expect(runnerSlot("toad")?.name).toBe("toad-box");
  });

  test("list and view show the fleet", async () => {
    const table = await run("mario", ["runner", "list"]);
    expect(table.code, table.stderr).toBe(0);
    expect(table.stdout).toContain("ci-box");
    expect(table.stdout).toContain("toad-box");
    expect(table.stdout).toContain("online");

    const json = await run("mario", ["--json", "runner", "list"]);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as {
      runners: { name: string; status: string; owner: { name: string } }[];
      pagination: { total: number };
    };
    expect(body.runners.map((r) => r.name).sort()).toEqual([
      "ci-box",
      "toad-box",
    ]);
    expect(body.pagination.total).toBe(2);
    expect(json.stdout).not.toContain("hyp_rt_");

    const view = await run("mario", ["runner", "view", "ci-box"]);
    expect(view.code, view.stderr).toBe(0);
    expect(view.stdout).toContain(`ci-box  (#${runnerId})`);
    expect(view.stdout).toContain("online");
    expect(view.stdout).toContain("Mario");

    const missing = await run("mario", ["runner", "view", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No runner named "nope"');
  });

  test("register into another project refuses to orphan this machine's runner without --force", async () => {
    const result = await run("mario", [
      "--project",
      String(universe.mario.projectId),
      "runner",
      "register",
      "--name",
      "elsewhere",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("orphan");
    expect(runnerSlot("mario")?.runnerId).toBe(runnerId);
  });

  test("edit pauses a runner, and someone else's runner is refused", async () => {
    const paused = await run("mario", [
      "runner",
      "edit",
      "ci-box",
      "--disable",
    ]);
    expect(paused.code, paused.stderr).toBe(0);
    expect(paused.stdout).toContain("paused");
    expect((await viewRunner(universe.mario, runnerId)).enabled).toBe(false);

    const theirs = await run("toad", ["runner", "edit", "ci-box", "--enable"]);
    expect(theirs.code).toBe(1);
    expect(theirs.stderr).toContain("owner or a project admin");
  });

  test("revoke needs --yes off a terminal, then revokes and forgets the token", async () => {
    const asked = await run("mario", ["runner", "revoke", "ci-box"]);
    expect(asked.code).toBe(1);
    expect(asked.stderr).toContain("--yes");

    const result = await run("mario", ["runner", "revoke", "ci-box", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Revoked runner");
    expect((await viewRunner(universe.mario, runnerId)).status).toBe("revoked");
    expect(runnerSlot("mario")).toBeNull();
  });

  test("a credentials file other users can read is refused, with the fix", async () => {
    chmodSync(credentialsFile(homes.toad!), 0o644);
    const result = await run("toad", ["runner", "list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `chmod 600 ${credentialsFile(homes.toad!)}`,
    );
    chmodSync(credentialsFile(homes.toad!), 0o600);
  });
});
