import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { ACK_BODY } from "../../ops/LinearWebhookOps";
import { useFinear } from "../linear/finear";
import { installationRow } from "../linear/helpers";
import {
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  authHeaders,
  buildTestUniverse,
  computeS256Challenge,
  HOOK_TIMEOUT,
  randomString,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse session`, spawned from source against the booted server, with
 * one delegation to `@hypotenuse` in finear mirrored and answered.
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
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-session-"));
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
  homes.luigi = await signIn(universe.luigi);
  homes.bowser = await signIn(universe.bowser);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let sessionId: number;
let identifier: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const { appUserId } = await installationRow(universe.projectId);
  const issue = await createIssue(linear, "Seen from the terminal");
  identifier = issue.identifier;
  const linearSessionId = await delegate(linear, issue.id, appUserId);
  await recordedEvent(
    (e) =>
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
      linearSessionId,
  );
  await settle();
  sessionId = (await sessionRow(linearSessionId))!.id;
}, HOOK_TIMEOUT);

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

describe("hypotenuse session", () => {
  test("list shows the project's sessions, as JSON and as a table", async () => {
    const json = await run("luigi", ["--json", "session", "list"]);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as {
      agentSessions: { id: number; issueIdentifier: string; status: string }[];
      pagination: { total: number };
    };
    expect(body.agentSessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        issueIdentifier: identifier,
        status: "error",
      }),
    ]);
    expect(body.pagination.total).toBe(1);

    const filtered = await run("luigi", [
      "--json",
      "session",
      "list",
      "--status",
      "active",
    ]);
    expect(JSON.parse(filtered.stdout).agentSessions).toEqual([]);

    const human = await run("luigi", ["session", "list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(identifier);
    expect(human.stdout).toContain("Seen from the terminal");
  });

  test("view shows the session and its activities in order", async () => {
    const json = await run("luigi", [
      "--json",
      "session",
      "view",
      String(sessionId),
    ]);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as {
      agentSession: { id: number };
      activities: { seq: number; content: { body?: string } }[];
    };
    expect(body.agentSession.id).toBe(sessionId);
    expect(body.activities.map((a) => a.seq)).toEqual([1, 2]);
    expect(body.activities[0].content.body).toBe(ACK_BODY);

    const human = await run("luigi", ["session", "view", String(sessionId)]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(identifier);
    expect(human.stdout).toContain(ACK_BODY);
    expect(human.stdout).toContain("sent");
  });

  test("an outsider is refused", async () => {
    const res = await run("bowser", ["session", "list"]);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toBe("");
  });
});
