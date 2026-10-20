import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { appToken } from "../linear/helpers";
import {
  authHeaders,
  buildTestUniverse,
  computeS256Challenge,
  cookieHeader,
  HOOK_TIMEOUT,
  randomString,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse linear`, spawned from source against the booted server and an
 * in-process finear. The Linear admin's browser is the harness's scripted
 * consent; everything the CLI does is real HTTP.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let universe: TestUniverse;
let url: string;
/** Each signed-in person's own config directory. */
const homes: Record<string, string> = {};

/**
 * Sign a test user's CLI in the way the dashboard would (approve, then
 * exchange), and write the credentials file a `login` would have written, with
 * the shared project selected.
 * @param user - Who to sign in.
 * @returns Their config directory.
 */
async function signIn(user: TestUser): Promise<string> {
  const verifier = randomString(64);
  const approve = await fetch(`${url}/api/cli-auth/approve`, {
    method: "PUT",
    headers: authHeaders(user.sessionId),
    body: JSON.stringify({
      codeChallenge: await computeS256Challenge(verifier),
      device: `${user.name}-laptop`,
    }),
  });
  const { code } = (await approve.json()) as { code: string };
  const exchange = await fetch(`${url}/api/cli-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  const { token, cliToken } = (await exchange.json()) as {
    token: string;
    cliToken: { id: number; device: string };
  };
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-linear-"));
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: {
            token,
            cliTokenId: cliToken.id,
            device: cliToken.device,
            email: user.email,
          },
          project: universe.projectId,
          runner: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  return home;
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  homes.peach = await signIn(universe.peach);
  homes.mario = await signIn(universe.mario);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

/**
 * The environment a spawned CLI runs with.
 * @param who - Whose config directory.
 * @returns The environment.
 */
function cliEnv(who: string) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: homes[who],
    BROWSER: "none",
    HYPOTENUSE_NO_UPDATE_CHECK: "1",
    HYPOTENUSE_URL: undefined,
    HYPOTENUSE_PROJECT: undefined,
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
  };
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
    env: cliEnv(who),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * `linear:installation` over HTTP, for comparing with what the CLI printed.
 * @returns The response body.
 */
async function installationOverHttp() {
  const res = await fetch(
    `${url}/api/linear/installation?projectId=${universe.projectId}`,
    { headers: cookieHeader(universe.peach.sessionId) },
  );
  return res.json();
}

describe("hypotenuse linear", () => {
  test("status before connecting says so", async () => {
    const human = await run("peach", ["linear", "status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Not connected to Linear");

    const json = await run("peach", ["--json", "linear", "status"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      installation: null,
      configured: true,
    });
  });

  test("connect prints an actor=app consent URL, and finishes once a Linear admin approves", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        CLI,
        "--json",
        "linear",
        "connect",
        "--no-browser",
        "--timeout",
        "30",
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: cliEnv("peach") },
    );
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = "";
    let match: RegExpMatchArray | null = null;
    const deadline = Date.now() + 20_000;
    while (!match && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value);
      match = stderr.match(/(https?:\/\/\S+\/oauth\/authorize\?\S+)/);
    }
    if (!match) throw new Error(`no consent URL printed: ${stderr}`);
    const authorize = new URL(match[1]!);
    expect(authorize.searchParams.get("actor")).toBe("app");
    expect(authorize.searchParams.get("prompt")).toBe("consent");

    // The Linear admin approves in Peach's browser.
    const callbackUrl = await linear.consent(match[1]!);
    const landed = await linear.callback(callbackUrl, universe.peach.sessionId);
    expect(landed.searchParams.get("connected")).toBe("1");

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value);
    }
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.installation).toMatchObject({
      status: "active",
      organizationName: "Workspace 1",
      urlKey: "eng",
    });
  }, 40_000);

  test("status shows the workspace, and --json is the action's answer with no token in it", async () => {
    const human = await run("peach", ["linear", "status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Workspace 1 (eng)");
    expect(human.stdout).toContain("Hypotenuse");

    const json = await run("peach", ["--json", "linear", "status"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(await installationOverHttp());
    expect(json.stdout).not.toContain(await appToken(universe.projectId));
  });

  test("a member without the admin tag is refused connect and disconnect", async () => {
    const connect = await run("mario", ["linear", "connect", "--no-browser"]);
    expect(connect.code).toBe(1);
    expect(connect.stderr).toContain("admin");
    const disconnect = await run("mario", ["linear", "disconnect", "--yes"]);
    expect(disconnect.code).toBe(1);
    expect(disconnect.stderr).toContain("admin");
    // And a member can still read the connection.
    expect((await run("mario", ["linear", "status"])).code).toBe(0);
  });

  test("disconnect asks for --yes off a terminal, then revokes", async () => {
    const token = await appToken(universe.projectId);
    const unconfirmed = await run("peach", ["linear", "disconnect"]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");

    const done = await run("peach", [
      "--json",
      "linear",
      "disconnect",
      "--yes",
    ]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout).installation.status).toBe("revoked");

    const viewer = await linear.graphql(`Bearer ${token}`, "{ viewer { id } }");
    expect(viewer.errors?.length ?? 0).toBeGreaterThan(0);
    const after = await run("peach", ["linear", "status"]);
    expect(after.stdout).toContain("Not connected to Linear");
  });
});
