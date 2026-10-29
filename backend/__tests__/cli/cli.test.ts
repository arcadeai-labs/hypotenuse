import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, config } from "keryx";
import {
  authHeaders,
  buildTestUniverse,
  cliSignIn,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The real `hypotenuse` CLI, spawned from source against the booted server —
 * the operator's whole path, with the browser replaced by the test approving
 * as a signed-in user over HTTP.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
const ANSI = /\x1b\[/;

let universe: TestUniverse;
let url: string;
let home: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  home = mkdtempSync(join(tmpdir(), "hyp-cli-"));
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The environment every spawned CLI runs with: its own config directory, no
 * browser, no update check, and no color unless a test asks.
 * @param over - Overrides.
 * @returns The environment.
 */
function cliEnv(over: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    BROWSER: "none",
    HYPOTENUSE_NO_UPDATE_CHECK: "1",
    HYPOTENUSE_URL: undefined,
    HYPOTENUSE_PROJECT: undefined,
    HYPOTENUSE_ORG: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    ...over,
  };
  return env;
}

/**
 * A CLI sign-in for a user, shaped as `credentials.json` stores it.
 * @param user - Whose.
 * @param device - The machine name.
 * @returns The login entry.
 */
async function cliToken(user: TestUser, device: string) {
  const { token, cliTokenId } = await cliSignIn(url, user, device);
  return { token, cliTokenId, device, email: user.email };
}

/**
 * Run the CLI to completion.
 * @param args - Arguments after `hypotenuse`.
 * @param env - Environment overrides.
 * @returns Exit code and captured output.
 */
async function run(
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(env),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Start the CLI and read its stderr until a line matches, leaving it running.
 * @param args - Arguments after `hypotenuse`.
 * @param pattern - What to wait for on stderr.
 * @returns The process, the match, and a function that finishes reading.
 */
async function startUntil(args: string[], pattern: RegExp) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(),
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  const deadline = Date.now() + 20_000;
  let match: RegExpMatchArray | null = null;
  while (!match && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    stderr += decoder.decode(value);
    match = stderr.match(pattern);
  }
  if (!match) throw new Error(`CLI never printed ${pattern}: ${stderr}`);
  const finish = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value);
    }
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout, stderr };
  };
  return { match, finish };
}

describe("hypotenuse against a real server", () => {
  test("login: the browser approves, the CLI is signed in, no password typed", async () => {
    const { match, finish } = await startUntil(
      ["login", "--url", url, "--name", "peach-laptop"],
      /(https?:\/\/\S+\/cli\/authorize\?\S+)/,
    );
    const authorize = new URL(match[1]!);
    expect(authorize.origin).toBe(new URL(config.frontend.url).origin);
    expect(authorize.searchParams.get("device")).toBe("peach-laptop");

    // What the dashboard page does when Peach clicks Approve.
    const approve = await fetch(`${url}/api/cli-auth/approve`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        codeChallenge: authorize.searchParams.get("code_challenge"),
        device: authorize.searchParams.get("device"),
      }),
    });
    const { code } = (await approve.json()) as { code: string };
    const callback = new URL(
      `http://127.0.0.1:${authorize.searchParams.get("port")}/callback`,
    );
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    const redirected = await fetch(callback, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toEndWith(
      "/cli/authorize?status=done",
    );

    const done = await finish();
    expect(done.code).toBe(0);
    expect(done.stdout.trim()).toBe(
      `Signed in to ${url} as ${universe.peach.email}`,
    );

    const path = join(home, "hypotenuse", "credentials.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.current).toBe(url);
    expect(saved.servers[url].login.token).toMatch(/^hyp_cli_/);
    expect(saved.servers[url].login.device).toBe("peach-laptop");
  });

  test("whoami, as JSON with no color, needs no --url once signed in", async () => {
    const { code, stdout } = await run(["--json", "whoami"], {
      FORCE_COLOR: "1",
    });
    expect(code).toBe(0);
    expect(stdout).not.toMatch(ANSI);
    const body = JSON.parse(stdout);
    expect(body.server).toBe(url);
    expect(body.user.email).toBe(universe.peach.email);
  });

  test("project list → use → invite create → audit list", async () => {
    const list = await run(["--json", "project", "list"]);
    expect(list.code).toBe(0);
    const { projects, pagination } = JSON.parse(list.stdout);
    expect(pagination).toMatchObject({ page: 1, limit: 25 });
    const shared = projects.find(
      (p: { id: number }) => p.id === universe.projectId,
    );
    expect(shared).toBeDefined();

    const use = await run(["project", "use", shared.slug]);
    expect(use.code).toBe(0);
    expect(use.stdout).toContain(`id ${universe.projectId}`);

    const invite = await run([
      "--json",
      "invite",
      "create",
      "--email",
      "daisy@sarasa.land",
      "--tag",
      String(universe.tagIds.viewers),
    ]);
    expect(invite.code).toBe(0);
    expect(JSON.parse(invite.stdout).invite).toMatchObject({
      inviteeEmail: "daisy@sarasa.land",
      projectId: universe.projectId,
      tagIds: [universe.tagIds.viewers],
    });

    const audit = await run(["--json", "audit", "list", "--since", "1h"]);
    expect(audit.code).toBe(0);
    const actions = JSON.parse(audit.stdout).auditLogs.map(
      (a: { action: string }) => a.action,
    );
    expect(actions).toContain("invite:create");
    // Signing a CLI in is the person's own business, not the project's: its
    // audit row has no project, so a project's log does not list it.
    expect(actions).not.toContain("cli-auth:approve");
  });

  test("tables are plain when piped and painted only when forced", async () => {
    const piped = await run(["project", "list"]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toMatch(
      /^\s*ID\s+SLUG\s+NAME\s+ORG\s+STANDING\s+CREATED/m,
    );
    expect(piped.stdout).not.toMatch(ANSI);

    const forced = await run(["--force-color", "project", "list"]);
    expect(forced.stdout).toMatch(ANSI);

    const noColor = await run(["project", "list"], {
      FORCE_COLOR: "1",
      NO_COLOR: "1",
    });
    // FORCE_COLOR outranks NO_COLOR; the flag outranks both.
    expect(noColor.stdout).toMatch(ANSI);
    const flag = await run(["--no-color", "project", "list"], {
      FORCE_COLOR: "1",
    });
    expect(flag.stdout).not.toMatch(ANSI);
  });

  test("a refusal exits non-zero with the server's message on stderr, nothing on stdout", async () => {
    // Toad's project, which Peach is not in.
    const { code, stdout, stderr } = await run([
      "--project",
      String(universe.toad.projectId),
      "member",
      "list",
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("not a member");
  });

  test("login --device completes from a second device", async () => {
    // Poll fast: control time by configuration, never by waiting.
    const interval = config.cliAuth.pollIntervalSeconds;
    config.cliAuth.pollIntervalSeconds = 0.05;
    try {
      const { match, finish } = await startUntil(
        ["--json", "login", "--device", "--name", "ssh-box"],
        /enter the code: ([B-Z]{4}-[B-Z]{4})/,
      );
      const activate = await fetch(`${url}/api/cli-auth/activate`, {
        method: "POST",
        headers: authHeaders(universe.mario.sessionId),
        body: JSON.stringify({ userCode: match[1] }),
      });
      expect(activate.status).toBe(200);
      const done = await finish();
      expect(done.code).toBe(0);
      expect(done.stderr).toContain("/cli/activate");
      const body = JSON.parse(done.stdout);
      expect(body.user.email).toBe(universe.mario.email);
      expect(body.cliToken.device).toBe("ssh-box");
    } finally {
      config.cliAuth.pollIntervalSeconds = interval;
    }

    // Replacing Peach's sign-in on this machine revoked hers on the server.
    const peachTokens = await fetch(`${url}/api/cli-tokens`, {
      headers: authHeaders(universe.peach.sessionId),
    });
    const { cliTokens } = (await peachTokens.json()) as {
      cliTokens: { device: string }[];
    };
    expect(cliTokens.map((t) => t.device)).not.toContain("peach-laptop");
  });

  test("a sign-in revoked from the Account page gets one 401 and the way back", async () => {
    const saved = JSON.parse(
      readFileSync(join(home, "hypotenuse", "credentials.json"), "utf8"),
    );
    const revoke = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ cliTokenId: saved.servers[url].login.cliTokenId }),
    });
    expect(revoke.status).toBe(200);

    const who = await run(["whoami"]);
    expect(who.code).toBe(1);
    expect(who.stdout).toBe("");
    expect(who.stderr).toContain("invalid, revoked, or expired");
    expect(who.stderr).toContain("hypotenuse login");

    // logout still forgets it locally, and says the server had already let go.
    const out = await run(["--json", "logout"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ server: url, revoked: false });
  });

  test("logout revokes on the server, and whoami then says how to sign in", async () => {
    const token = await cliToken(universe.mario, "ssh-box-2");
    const path = join(home, "hypotenuse", "credentials.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.servers[url].login = token;
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });

    const out = await run(["logout"]);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe(`Signed out of ${url}`);

    const marioTokens = await fetch(`${url}/api/cli-tokens`, {
      headers: authHeaders(universe.mario.sessionId),
    });
    const { cliTokens } = (await marioTokens.json()) as {
      cliTokens: { device: string }[];
    };
    expect(cliTokens.map((t) => t.device)).not.toContain("ssh-box-2");

    const who = await run(["whoami"]);
    expect(who.code).toBe(1);
    expect(who.stderr).toContain("hypotenuse login");
  });
});
