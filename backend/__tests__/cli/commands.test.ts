import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import {
  buildTestUniverse,
  cliSignIn,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * Every operator command, spawned from source against the booted server and
 * the Mushroom Kingdom: each person gets their own config directory holding a
 * CLI token issued through the real approve → exchange round trip (signing in
 * itself is `cli.test.ts`'s), and every assertion reads the `--json` answer.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let universe: TestUniverse;
let url: string;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-cmd-"));
  const { token, cliTokenId } = await cliSignIn(url, user, `${user.name}-cli`);
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: { token, cliTokenId, device: `${user.name}-cli` },
          organization: null,
          project: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  homes.set(user.email, home);
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  for (const user of [universe.peach, universe.bowser, universe.daisy]) {
    await signIn(user);
  }
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI as a person.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse`.
 * @returns Exit code and captured output.
 */
async function as(user: TestUser, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: homes.get(user.email),
      BROWSER: "none",
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_URL: undefined,
      HYPOTENUSE_ORG: undefined,
      HYPOTENUSE_PROJECT: undefined,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Run a command with `--json` that must succeed, and parse its answer.
 * @param user - Who.
 * @param args - Arguments after `hypotenuse --json`.
 * @returns The parsed stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the action's own shape.
async function json(user: TestUser, args: string[]): Promise<any> {
  const out = await as(user, ["--json", ...args]);
  if (out.code !== 0) {
    throw new Error(`hypotenuse ${args.join(" ")}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

describe("org", () => {
  test("list pages, view, and use select the organization", async () => {
    const all = await json(universe.peach, ["org", "list"]);
    expect(all.pagination).toMatchObject({ page: 1, limit: 25, total: 1 });
    expect(all.organizations[0]).toMatchObject({
      id: universe.organizationId,
      name: "Mushroom Kingdom",
      standing: { role: "owner" },
    });

    const view = await json(universe.peach, [
      "org",
      "view",
      String(universe.organizationId),
    ]);
    expect(view.standing.role).toBe("owner");

    const used = await json(universe.peach, [
      "org",
      "use",
      all.organizations[0].slug,
    ]);
    expect(used.organization.id).toBe(universe.organizationId);
  });

  test("members lists roles; member set-role and member remove change them", async () => {
    const before = await json(universe.peach, ["org", "members"]);
    const roles = Object.fromEntries(
      before.memberships.map((m: { user: { email: string }; role: string }) => [
        m.user.email,
        m.role,
      ]),
    );
    expect(roles[universe.peach.email]).toBe("owner");
    expect(roles[universe.daisy.email]).toBe("member");

    const promoted = await json(universe.peach, [
      "org",
      "member",
      "set-role",
      String(universe.daisy.userId),
      "owner",
    ]);
    expect(promoted.membership.role).toBe("owner");
    await json(universe.peach, [
      "org",
      "member",
      "set-role",
      String(universe.daisy.userId),
      "member",
    ]);

    const bad = await as(universe.peach, [
      "org",
      "member",
      "set-role",
      String(universe.daisy.userId),
      "emperor",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("owner or member");
  });

  test("create, edit, and delete an organization; delete needs --yes", async () => {
    const created = await json(universe.peach, [
      "org",
      "create",
      "--name",
      "Sky Land",
    ]);
    const id = String(created.organization.id);
    const edited = await json(universe.peach, [
      "org",
      "edit",
      id,
      "--name",
      "Sky Kingdom",
      "--slug",
      "sky-kingdom",
    ]);
    expect(edited.organization).toMatchObject({
      name: "Sky Kingdom",
      slug: "sky-kingdom",
    });

    const unconfirmed = await as(universe.peach, ["org", "delete", id]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");

    const deleted = await json(universe.peach, [
      "org",
      "delete",
      "sky-kingdom",
      "--yes",
    ]);
    expect(deleted.success).toBe(true);
  });
});

describe("project", () => {
  test("list, narrowed by an explicit --org, and paged", async () => {
    const all = await json(universe.peach, ["project", "list"]);
    const ids = all.projects.map((p: { id: number }) => p.id);
    expect(ids).toContain(universe.projectId);
    expect(ids).toContain(universe.peach.projectId);

    const page = await json(universe.peach, [
      "project",
      "list",
      "--page",
      "2",
      "--limit",
      "1",
    ]);
    expect(page.pagination).toMatchObject({ page: 2, limit: 1 });
    expect(page.projects).toHaveLength(1);

    const bowsers = await json(universe.bowser, [
      "--org",
      String(universe.koopaOrganizationId),
      "project",
      "list",
    ]);
    expect(bowsers.projects.map((p: { id: number }) => p.id)).toEqual([
      universe.bowser.projectId,
    ]);
  });

  test("use, then view reads the selection; create lands in the selected organization", async () => {
    await json(universe.peach, ["project", "use", String(universe.projectId)]);
    const view = await json(universe.peach, ["project", "view"]);
    expect(view.project.name).toBe("Castle");
    expect(view.organization.name).toBe("Mushroom Kingdom");
    expect(view.standing.isAdmin).toBe(true);

    const created = await json(universe.peach, [
      "project",
      "create",
      "--name",
      "Garden",
    ]);
    expect(created.project.organizationId).toBe(universe.organizationId);

    const renamed = await json(universe.peach, [
      "project",
      "edit",
      String(created.project.id),
      "--name",
      "Royal Garden",
    ]);
    expect(renamed.project.name).toBe("Royal Garden");

    const unconfirmed = await as(universe.peach, [
      "project",
      "delete",
      String(created.project.id),
    ]);
    expect(unconfirmed.code).toBe(1);
    const deleted = await json(universe.peach, [
      "project",
      "delete",
      String(created.project.id),
      "--yes",
    ]);
    expect(deleted.success).toBe(true);
  });

  test("a project of someone else's is the server's refusal, on stderr", async () => {
    const out = await as(universe.bowser, [
      "project",
      "view",
      String(universe.projectId),
    ]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("not a member");
  });
});

describe("member", () => {
  test("list shows tags; add takes an organization member; remove removes", async () => {
    const list = await json(universe.peach, ["member", "list"]);
    const mario = list.memberships.find(
      (m: { userId: number }) => m.userId === universe.mario.userId,
    );
    expect(mario.tags.map((t: { name: string }) => t.name)).toEqual([
      "operators",
    ]);

    const added = await json(universe.peach, [
      "member",
      "add",
      "--email",
      universe.daisy.email,
    ]);
    expect(added.membership.userId).toBe(universe.daisy.userId);

    const removed = await json(universe.peach, [
      "member",
      "remove",
      String(universe.daisy.userId),
    ]);
    expect(removed.success).toBe(true);
  });
});

describe("tag", () => {
  test("create, edit, assign, remove, delete — and the admin tag stays reserved", async () => {
    const created = await json(universe.peach, ["tag", "create", "gardeners"]);
    const id = String(created.tag.id);
    const edited = await json(universe.peach, [
      "tag",
      "edit",
      id,
      "--name",
      "groundskeepers",
    ]);
    expect(edited.tag.name).toBe("groundskeepers");

    const assigned = await json(universe.peach, [
      "tag",
      "assign",
      id,
      "--user",
      String(universe.toad.userId),
    ]);
    expect(assigned.userTag).toBeDefined();
    const removed = await json(universe.peach, [
      "tag",
      "remove",
      id,
      "--user",
      String(universe.toad.userId),
    ]);
    expect(removed.success).toBe(true);

    const list = await json(universe.peach, ["tag", "list"]);
    const names = list.tags.map((t: { name: string }) => t.name);
    expect(names).toContain("groundskeepers");
    const admin = list.tags.find((t: { name: string }) => t.name === "admin");
    expect(admin.reserved).toBe(true);

    const reserved = await as(universe.peach, [
      "tag",
      "edit",
      String(admin.id),
      "--name",
      "boss",
    ]);
    expect(reserved.code).toBe(1);
    expect(reserved.stderr).toContain("reserved");

    expect((await json(universe.peach, ["tag", "delete", id])).success).toBe(
      true,
    );
  });
});

describe("invite", () => {
  test("a project invite with a tag is accepted from the invitee's own CLI", async () => {
    const sent = await json(universe.peach, [
      "invite",
      "create",
      "--email",
      universe.bowser.email,
      "--tag",
      String(universe.tagIds.viewers),
    ]);
    expect(sent.invite).toMatchObject({
      kind: "project",
      projectId: universe.projectId,
      tagIds: [universe.tagIds.viewers],
    });

    const listed = await json(universe.peach, ["invite", "list"]);
    expect(listed.invites.map((i: { id: number }) => i.id)).toContain(
      sent.invite.id,
    );

    const pending = await json(universe.bowser, ["invite", "pending"]);
    expect(pending.invites.map((i: { id: number }) => i.id)).toContain(
      sent.invite.id,
    );
    const accepted = await json(universe.bowser, [
      "invite",
      "accept",
      String(sent.invite.id),
    ]);
    expect(accepted.membership.projectId).toBe(universe.projectId);

    const view = await json(universe.bowser, [
      "project",
      "view",
      String(universe.projectId),
    ]);
    expect(view.callerTags.map((t: { name: string }) => t.name)).toEqual([
      "viewers",
    ]);
  });

  test("an organization-only invite is listed with --org and can be rejected", async () => {
    const outsider = await as(universe.peach, [
      "invite",
      "create",
      "--email",
      "someone@else.where",
      "--organization-only",
      "--tag",
      "1",
    ]);
    expect(outsider.code).toBe(1);
    expect(outsider.stderr).toContain("--organization-only");

    // Daisy is in the organization already, so a project invite it is.
    const sent = await json(universe.peach, [
      "invite",
      "create",
      "--email",
      universe.daisy.email,
    ]);
    const rejected = await json(universe.daisy, [
      "invite",
      "reject",
      String(sent.invite.id),
    ]);
    expect(rejected.invite.status).toBe("rejected");

    const orgInvite = await json(universe.peach, [
      "invite",
      "create",
      "--email",
      "rosalina@comet.observatory",
      "--organization-only",
    ]);
    expect(orgInvite.invite).toMatchObject({
      kind: "organization",
      projectId: null,
    });
    const orgList = await json(universe.peach, [
      "--org",
      String(universe.organizationId),
      "invite",
      "list",
    ]);
    expect(orgList.invites.map((i: { id: number }) => i.id)).toContain(
      orgInvite.invite.id,
    );
  });
});

describe("audit", () => {
  test("the project's log, filtered, then the organization's, narrowed by project", async () => {
    const project = await json(universe.peach, [
      "audit",
      "list",
      "--since",
      "1h",
      "--action",
      "tag:edit",
    ]);
    expect(project.auditLogs.length).toBeGreaterThan(0);
    for (const row of project.auditLogs) {
      expect(row.action).toBe("tag:edit");
      expect(row.projectId).toBe(universe.projectId);
    }
    expect(project.pagination).toMatchObject({ page: 1, limit: 25 });

    const organization = await json(universe.peach, [
      "--org",
      String(universe.organizationId),
      "audit",
      "list",
      "--since",
      "1h",
    ]);
    const actions = organization.auditLogs.map(
      (a: { action: string }) => a.action,
    );
    // Organization rows (no project) are in the organization's log.
    expect(actions).toContain("organization-membership:edit");

    const narrowed = await json(universe.peach, [
      "--org",
      String(universe.organizationId),
      "--project",
      String(universe.projectId),
      "audit",
      "list",
      "--since",
      "1h",
    ]);
    for (const row of narrowed.auditLogs) {
      expect(row.projectId).toBe(universe.projectId);
    }

    const orgOnly = await json(universe.peach, [
      "--org",
      String(universe.organizationId),
      "audit",
      "list",
      "--since",
      "1h",
      "--org-only",
    ]);
    expect(orgOnly.auditLogs.length).toBeGreaterThan(0);
    for (const row of orgOnly.auditLogs) {
      expect(row.projectId).toBeNull();
    }
    const noOrg = await as(universe.peach, ["audit", "list", "--org-only"]);
    expect(noOrg.code).toBe(1);
    expect(noOrg.stderr).toContain("add --org");

    const bad = await as(universe.peach, ["audit", "list", "--since", "soon"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Not a time");
  });

  test("an outsider's organization log is refused", async () => {
    const out = await as(universe.bowser, [
      "--org",
      String(universe.organizationId),
      "audit",
      "list",
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("owner");
  });
});
