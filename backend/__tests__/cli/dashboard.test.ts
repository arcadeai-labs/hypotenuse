import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { ackBody } from "../../ops/WorkItemOps";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import { registerRunner, type TestRunner } from "../runners/helpers";
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
 * The operator CLI's view of what the dashboard shows — `routing preview`,
 * `project overview`, `session view <ENG-123>` with its turns, transcript,
 * and `--follow`, `session list --runner`, and the webhook deliveries in
 * `integration view` — spawned from source against the booted server and
 * finear, with one delegation mirrored and one runner registered but never
 * heartbeating.
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
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-dashboard-"));
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

let sessionId: number;
let identifier: string;
let runner: TestRunner;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  // Registered, never heartbeated: offline, and so a reason in the preview.
  runner = await registerRunner(
    url,
    universe.mario,
    universe.projectId,
    "dash-laptop",
  );
  const { externalAppUserId } = await integrationRow(universe.projectId);
  const issue = await createIssue(linear, "Routed from the terminal");
  identifier = issue.identifier;
  const externalSessionId = await delegate(linear, issue.id, externalAppUserId);
  await recordedEvent(
    (e) =>
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
      externalSessionId,
  );
  await settle();
  sessionId = (await sessionRow(externalSessionId))!.id;
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

/**
 * Start the CLI and leave it running, collecting stdout.
 * @param who - Whose sign-in.
 * @param args - Arguments after `hypotenuse`.
 * @returns The process and what it has printed so far.
 */
function spawnCli(who: string, args: string[]) {
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
  const out = { text: "" };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) out.text += decoder.decode(chunk);
  })();
  return { proc, out };
}

/**
 * Wait until a condition holds, or fail.
 * @param check - The condition.
 * @param what - What is awaited, for the failure.
 */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

describe("hypotenuse routing preview", () => {
  test("the default role, and the offline runner with its reason", async () => {
    const json = await run("luigi", [
      "--json",
      "routing",
      "preview",
      identifier,
    ]);
    expect(json.code).toBe(0);
    const { preview } = JSON.parse(json.stdout) as {
      preview: {
        issue: { identifier: string };
        role: string;
        matchedRuleId: number | null;
        waitingCode: string | null;
        candidates: {
          runnerId: number;
          eligible: boolean;
          reasons: { code: string }[];
        }[];
      };
    };
    expect(preview.issue.identifier).toBe(identifier);
    expect(preview.role).toBe("worker");
    const mine = preview.candidates.find((c) => c.runnerId === runner.id);
    expect(mine?.eligible).toBe(false);
    expect(mine?.reasons.map((r) => r.code)).toContain("offline");
    expect(preview.waitingCode).not.toBeNull();

    const human = await run("luigi", ["routing", "preview", identifier]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("dash-laptop");
    expect(human.stdout).toContain("offline");
    expect(human.stdout).toContain("role       worker");
  });

  test("a prompt routes as a mention", async () => {
    const json = await run("luigi", [
      "--json",
      "routing",
      "preview",
      identifier,
      "--prompt",
      "/manage plan it",
    ]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).preview.origin).toBe("mention");
  });

  test("an issue Linear does not have is refused", async () => {
    const res = await run("luigi", ["routing", "preview", "NOPE-999"]);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("hypotenuse project overview", () => {
  test("counts the mirrored session and the runner, as JSON and as text", async () => {
    const json = await run("luigi", ["--json", "project", "overview"]);
    expect(json.code).toBe(0);
    const { overview } = JSON.parse(json.stdout) as {
      overview: {
        window: string;
        linear: { status: string } | null;
        runners: { offline: number };
        sessions: { total: number };
      };
    };
    expect(overview.window).toBe("24h");
    expect(overview.linear?.status).toBe("active");
    expect(overview.runners.offline).toBeGreaterThanOrEqual(1);
    expect(overview.sessions.total).toBe(1);

    const week = await run("luigi", [
      "--json",
      "project",
      "overview",
      "--window",
      "7d",
    ]);
    expect(JSON.parse(week.stdout).overview.window).toBe("7d");

    const human = await run("luigi", ["project", "overview"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Linear");
    expect(human.stdout).toContain("Sessions   1 in 24h");

    const bad = await run("luigi", ["project", "overview", "--window", "1y"]);
    expect(bad.code).not.toBe(0);
  });
});

describe("hypotenuse session view by issue", () => {
  test("an identifier names the newest session; turns and the transcript show", async () => {
    const json = await run("luigi", ["--json", "session", "view", identifier]);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.stdout) as {
      agentSession: { id: number };
      workItems: { kind: string; status: string }[];
      activities: { seq: number }[];
    };
    expect(body.agentSession.id).toBe(sessionId);
    expect(body.workItems[0]?.kind).toBe("session_created");
    expect(body.activities.length).toBeGreaterThan(0);

    const human = await run("luigi", ["session", "view", identifier]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Turns");
    expect(human.stdout).toContain("session_created");

    const transcript = await run("luigi", [
      "session",
      "view",
      identifier,
      "--transcript",
    ]);
    expect(transcript.code).toBe(0);
    expect(transcript.stdout).toContain(ackBody(identifier));
    expect(transcript.stdout).not.toContain("Turns");

    const missing = await run("luigi", ["session", "view", "ZZZ-1"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("No session on ZZZ-1");
  });

  test("--follow prints the transcript and keeps running until interrupted", async () => {
    const { proc, out } = spawnCli("luigi", [
      "session",
      "view",
      identifier,
      "--transcript",
      "--follow",
      "--interval",
      "0.2",
    ]);
    await until(() => out.text.includes(ackBody(identifier)), "the transcript");
    await Bun.sleep(500);
    expect(proc.exitCode).toBeNull();
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
  });

  test("list filters by runner", async () => {
    const json = await run("luigi", [
      "--json",
      "session",
      "list",
      "--runner",
      String(runner.id),
    ]);
    expect(json.code).toBe(0);
    // The session never reached this runner: it is offline.
    expect(JSON.parse(json.stdout).agentSessions).toEqual([]);
  });
});

describe("hypotenuse integration view", () => {
  test("shows the last webhook and the recent deliveries", async () => {
    const json = await run("luigi", [
      "--json",
      "integration",
      "view",
      "linear",
    ]);
    const body = JSON.parse(json.stdout) as {
      deliveries: {
        lastReceivedAt: number | null;
        recent: { eventType: string; outcome: string }[];
      };
    };
    expect(body.deliveries.lastReceivedAt).not.toBeNull();
    expect(body.deliveries.recent).toContainEqual(
      expect.objectContaining({ eventType: "AgentSessionEvent" }),
    );
    const human = await run("luigi", ["integration", "view", "linear"]);
    expect(human.stdout).toContain("webhook    last received");
    expect(human.stdout).toContain("AgentSessionEvent");
  });
});
