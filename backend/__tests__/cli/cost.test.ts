import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  delegatedSession,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
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
 * `hypotenuse cost`, spawned from source against the booted server: a turn a
 * scripted daemon ran and reported the cost of, listed, totalled by runner,
 * and shown on `session view`.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let universe: TestUniverse;
let url: string;
const homes: Record<string, string> = {};

/**
 * Sign a test user's CLI in the way the dashboard would, with the shared
 * project selected.
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
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-cost-"));
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
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let identifier: string;
let sessionId: number;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const { externalAppUserId } = await integrationRow(universe.projectId);
  const laptop = await ScriptedDaemon.register(
    url,
    universe.mario,
    universe.projectId,
    "cost-cli-laptop",
  );
  await laptop.heartbeat();
  const { session } = await delegatedSession(
    linear,
    externalAppUserId,
    "Count the cost",
  );
  identifier = session.issueIdentifier!;
  sessionId = session.id;
  const assignment = await laptop.claim();
  await laptop.complete(assignment!.workItemId, "completed", {
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.75 },
  });
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

describe("hypotenuse cost", () => {
  test("list shows each turn's cost and the total", async () => {
    const json = await run("luigi", ["--json", "cost", "list"]);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as {
      costRecords: { agentSessionId: number; costUsd: number | null }[];
      total: { turns: number; costUsd: number | null };
    };
    expect(body.costRecords).toEqual([
      expect.objectContaining({ agentSessionId: sessionId, costUsd: 0.75 }),
    ]);
    expect(body.total).toMatchObject({ turns: 1, costUsd: 0.75 });

    const human = await run("luigi", ["cost", "list", "--since", "1h"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(identifier);
    expect(human.stdout).toContain("cost-cli-laptop");
    expect(human.stdout).toContain("1200 / 300");
    expect(human.stdout).toContain(
      "total $0.75 over 1 turn, 1,200 in / 300 out",
    );

    const none = await run("luigi", [
      "--json",
      "cost",
      "list",
      "--role",
      "manager",
    ]);
    expect(JSON.parse(none.stdout).costRecords).toEqual([]);
  });

  test("summary totals by a dimension", async () => {
    const human = await run("luigi", ["cost", "summary", "--by", "runner"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("RUNNER");
    expect(human.stdout).toMatch(
      /cost-cli-laptop\s+1\s+0\s+1200\s+300\s+\$0\.75/,
    );
    const bad = await run("luigi", ["cost", "summary", "--by", "planet"]);
    expect(bad.code).not.toBe(0);
  });

  test("session view shows what the session cost", async () => {
    const human = await run("luigi", ["session", "view", identifier]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(
      "cost       $0.75 over 1 turn, 1,200 in / 300 out",
    );
    expect(human.stdout).not.toContain("tree cost");
  });
});
