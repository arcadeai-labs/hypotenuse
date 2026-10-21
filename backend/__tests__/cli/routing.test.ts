import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentActivities } from "../../schema/agent_activities";
import { workItems } from "../../schema/work_items";
import { FINEAR_FIXTURES, useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
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
  cookieHeader,
  HOOK_TIMEOUT,
  randomString,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse routing`, `identity`, and `session cancel`, spawned from source
 * against the booted server with a finear workspace connected.
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
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-routing-"));
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
  homes.luigi = await signIn(universe.luigi);
  homes.bowser = await signIn(universe.bowser);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let teamKey: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const res = await fetch(
    `${url}/api/integration/catalog?projectId=${universe.projectId}&type=linear`,
    { headers: cookieHeader(universe.peach.sessionId) },
  );
  const catalog = (await res.json()) as { teams: { key: string }[] };
  teamKey = catalog.teams[0].key;
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

/** A rule as the CLI prints it under `--json`. */
interface Rule {
  id: number;
  position: number;
  name: string;
  role: string;
  enabled: boolean;
  match: Record<string, unknown>;
  repository: string | null;
}

/**
 * The project's rules, in order, as `routing list --json` answers them.
 * @returns The rules.
 */
async function rules(): Promise<Rule[]> {
  const res = await run("luigi", ["--json", "routing", "list"]);
  expect(res.code).toBe(0);
  return (JSON.parse(res.stdout) as { routingRules: Rule[] }).routingRules;
}

describe("hypotenuse routing", () => {
  test("list shows the seeded prefix rules and the fallthrough", async () => {
    expect((await rules()).map((r) => [r.name, r.role])).toEqual([
      ["/manage", "manager"],
      ["/work", "worker"],
    ]);
    const human = await run("luigi", ["routing", "list"]);
    expect(human.stdout).toContain("prefix=/manage");
    expect(human.stdout).toContain("No match: worker.");
  });

  test("add checks names against the workspace and appends the rule", async () => {
    const unknown = await run("peach", [
      "routing",
      "add",
      "--name",
      "PRDs",
      "--role",
      "manager",
      "--label",
      "No Such Label",
    ]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("No label named No Such Label");

    const added = await run("peach", [
      "--json",
      "routing",
      "add",
      "--name",
      "Team subissues",
      "--role",
      "manager",
      "--team",
      teamKey,
      "--has-parent",
      "--origin",
      "delegation",
      "--repository",
      "git@github.com:acme/web.git",
    ]);
    expect(added.code).toBe(0);
    const rule = (JSON.parse(added.stdout) as { routingRule: Rule })
      .routingRule;
    expect(rule).toEqual(
      expect.objectContaining({
        position: 2,
        role: "manager",
        enabled: true,
        repository: "github.com/acme/web",
        match: { teamKeys: [teamKey], hasParent: true, origin: "delegation" },
      }),
    );
  });

  test("a member cannot add a rule", async () => {
    const res = await run("luigi", [
      "routing",
      "add",
      "--name",
      "Mine",
      "--role",
      "worker",
    ]);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toBe("");
  });

  test("a project without Linear skips the check and says so", async () => {
    const res = await run("bowser", [
      "--project",
      String(universe.bowser.projectId),
      "routing",
      "add",
      "--name",
      "Bugs",
      "--role",
      "worker",
      "--label",
      "bug",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("no working Linear connection");
    expect(res.stdout).toContain('Added rule "Bugs"');
  });

  test("edit replaces the match, disables, and clears the pin", async () => {
    const target = (await rules())[2];
    const res = await run("peach", [
      "--json",
      "routing",
      "edit",
      String(target.id),
      "--no-parent",
      "--disable",
      "--clear-repository",
    ]);
    expect(res.code).toBe(0);
    expect(
      (JSON.parse(res.stdout) as { routingRule: Rule }).routingRule,
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        repository: null,
        match: { hasParent: false },
      }),
    );
    const nothing = await run("peach", ["routing", "edit", String(target.id)]);
    expect(nothing.code).not.toBe(0);
    expect(nothing.stderr).toContain("Nothing to change");
  });

  test("reorder sets the order; a partial list is refused", async () => {
    const before = await rules();
    const reversed = [...before].reverse().map((r) => String(r.id));
    const res = await run("peach", ["routing", "reorder", ...reversed]);
    expect(res.code).toBe(0);
    expect((await rules()).map((r) => String(r.id))).toEqual(reversed);

    const partial = await run("peach", ["routing", "reorder", reversed[0]]);
    expect(partial.code).not.toBe(0);
    expect(partial.stderr).toContain("exactly once");
  });

  test("remove deletes a rule and the rest move up", async () => {
    const [first, ...rest] = await rules();
    const res = await run("peach", ["routing", "remove", String(first.id)]);
    expect(res.code).toBe(0);
    const after = await rules();
    expect(after.map((r) => r.id)).toEqual(rest.map((r) => r.id));
    expect(after.map((r) => r.position)).toEqual(rest.map((_, i) => i));
  });

  test("settings show the defaults, change, and reset", async () => {
    const shown = await run("luigi", ["routing", "settings"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("queue timeout          30m");

    const changed = await run("peach", [
      "--json",
      "routing",
      "settings",
      "--queue-timeout",
      "45m",
      "--sticky-timeout",
      "0",
      "--repository-confidence",
      "0.9",
    ]);
    expect(changed.code).toBe(0);
    expect(JSON.parse(changed.stdout).routing).toEqual(
      expect.objectContaining({
        queueTimeoutMs: 2_700_000,
        stickyTimeoutMs: 0,
        repositoryConfidence: 0.9,
      }),
    );

    const refused = await run("luigi", [
      "routing",
      "settings",
      "--offer-ttl",
      "20s",
    ]);
    expect(refused.code).not.toBe(0);

    const reset = await run("peach", [
      "--json",
      "routing",
      "settings",
      "--reset",
      "queueTimeoutMs",
    ]);
    expect(JSON.parse(reset.stdout).routing.queueTimeoutMs).toBe(1_800_000);
    expect(JSON.parse(reset.stdout).routing.stickyTimeoutMs).toBe(0);
  });
});

describe("hypotenuse identity", () => {
  let identityId: number;

  test("an admin links a Linear user to a member", async () => {
    const res = await run("peach", [
      "--json",
      "identity",
      "link",
      "--user",
      String(universe.mario.userId),
      "--linear-user",
      FINEAR_FIXTURES.primary.user,
      "--name",
      "Human 1",
    ]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      externalIdentity: { id: number; userId: number; linkedVia: string };
    };
    expect(body.externalIdentity).toEqual(
      expect.objectContaining({
        userId: universe.mario.userId,
        linkedVia: "admin",
      }),
    );
    identityId = body.externalIdentity.id;

    const member = await run("luigi", [
      "identity",
      "link",
      "--user",
      String(universe.luigi.userId),
      "--linear-user",
      "someone-else",
    ]);
    expect(member.code).not.toBe(0);
  });

  test("list shows it to any member", async () => {
    const json = await run("luigi", ["--json", "identity", "list"]);
    expect(json.code).toBe(0);
    expect(
      (JSON.parse(json.stdout) as { externalIdentities: { id: number }[] })
        .externalIdentities,
    ).toEqual([expect.objectContaining({ id: identityId })]);
    const human = await run("luigi", ["identity", "list"]);
    expect(human.stdout).toContain("Human 1");
    expect(human.stdout).toContain("Mario <mario@mushroom.kingdom>");
  });

  test("only the linked member or an admin unlinks", async () => {
    const other = await run("luigi", [
      "identity",
      "unlink",
      String(identityId),
    ]);
    expect(other.code).not.toBe(0);
    const own = await run("mario", ["identity", "unlink", String(identityId)]);
    expect(own.code).toBe(0);
    expect(own.stdout).toContain(`Removed link #${identityId}`);
  });
});

describe("hypotenuse session cancel", () => {
  test("stops a session's queued work and the session is told", async () => {
    const { externalAppUserId } = await integrationRow(universe.projectId);
    const issue = await createIssue(linear, "Stopped from the terminal");
    const externalSessionId = await delegate(
      linear,
      issue.id,
      externalAppUserId,
    );
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    await settle();
    const session = (await sessionRow(externalSessionId))!;

    const res = await run("luigi", [
      "--json",
      "session",
      "cancel",
      String(session.id),
    ]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).agentSession.id).toBe(session.id);

    const items = await api.db.db
      .select()
      .from(workItems)
      .where(eq(workItems.agentSessionId, session.id));
    expect(items.map((i) => [i.status, i.cancelReason])).toEqual([
      ["cancelled", "dashboard"],
    ]);
    const activities = await api.db.db
      .select()
      .from(agentActivities)
      .where(eq(agentActivities.agentSessionId, session.id));
    expect(
      activities.some(
        (a) =>
          a.contentType === "response" &&
          (a.content as { body?: string }).body === "Stopped before starting.",
      ),
    ).toBe(true);

    const outsider = await run("bowser", [
      "session",
      "cancel",
      String(session.id),
    ]);
    expect(outsider.code).not.toBe(0);
  });
});
