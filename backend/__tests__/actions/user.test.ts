import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, isNull } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { UserCreate } from "../../actions/user";
import { auditLogs } from "../../schema/audit_logs";
import { organizationMemberships } from "../../schema/organization_memberships";
import { organizations } from "../../schema/organizations";
import { projectSettings } from "../../schema/project_settings";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";
import {
  buildTestUniverse,
  call,
  createUserAndLogin,
  HOOK_TIMEOUT,
  TEST_PASSWORD,
  type TestUniverse,
} from "../setup";

let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("user:create", () => {
  test("bootstraps an owned organization, a Default project, and its admin tag", async () => {
    const res = await call<ActionResponse<UserCreate>>(
      u.url,
      null,
      "PUT",
      "/user",
      {
        name: "Rosalina",
        email: "Rosalina@Comet.Observatory",
        password: "lumas-forever",
      },
    );
    expect(res.status).toBe(200);
    const { user, organization, project, membership } = res.body;
    expect(user.email).toBe("rosalina@comet.observatory");
    expect(user).not.toHaveProperty("password_hash");
    expect(organization).toMatchObject({
      name: "Rosalina's org",
      slug: "rosalina-s-org",
    });
    expect(project).toMatchObject({
      name: "Default",
      slug: "default",
      organizationId: organization.id,
    });
    expect(membership.userId).toBe(user.id);

    const [owner] = await api.db.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, organization.id));
    expect(owner).toMatchObject({ userId: user.id, role: "owner" });

    const held = await api.db.db
      .select({ name: tags.name })
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .where(and(eq(userTags.userId, user.id), eq(tags.projectId, project.id)));
    expect(held).toEqual([{ name: "admin" }]);

    const settings = await api.db.db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.projectId, project.id));
    expect(settings.length).toBe(1);
  });

  test("cuts a name too long for the organization so the suffix still fits", async () => {
    const name = "R".repeat(256);
    const res = await call<ActionResponse<UserCreate>>(
      u.url,
      null,
      "PUT",
      "/user",
      { name, email: "long@comet.observatory", password: "lumas-forever" },
    );
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe(`${"R".repeat(250)}'s org`);
  });

  test("writes the sign-up row and synthetic rows for the tenant it created", async () => {
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetPath, "rosalina@comet.observatory"));
    expect(rows.map((r) => [r.action, r.projectId])).toEqual([
      ["user:create", null],
    ]);
    // The sign-up row never carries the password, at any depth.
    expect(JSON.stringify(rows[0])).not.toContain("lumas-forever");

    const [org] = await api.db.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, "rosalina-s-org"));
    const [owner] = await api.db.db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, org.id));
    // The sign-up has no signed-in caller, so its actor is the account it
    // created. The tenant rows are the system's: nobody chose them, sign-up
    // always makes them. Their metadata names the owner they were made for.
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].userId).toBe(owner.userId);
    expect(rows[0].organizationId).toBeNull();
    const synthetic = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, org.id));
    expect(synthetic.map((r) => r.action).sort()).toEqual([
      "organization:create",
      "project:create",
    ]);
    for (const row of synthetic) {
      expect(row.actorType).toBe("system");
      expect(row.userId).toBeNull();
      expect(row.metadata).toMatchObject({
        bootstrappedBy: "user:create",
        ownerUserId: owner.userId,
      });
    }
    const orgRow = synthetic.find((r) => r.action === "organization:create")!;
    expect(orgRow.projectId).toBeNull();
    expect(orgRow.metadata).toMatchObject({ organizationId: org.id });
    const projectRow = synthetic.find((r) => r.action === "project:create")!;
    expect(projectRow.projectId).not.toBeNull();
  });

  test("a taken email, in any case, is refused and creates nothing", async () => {
    const [{ count: before }] = await api.db.db
      .select({ count: count() })
      .from(organizations);
    const res = await call(u.url, null, "PUT", "/user", {
      name: "Not Peach",
      email: "PEACH@mushroom.kingdom",
      password: "password123",
    });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("email");
    const [{ count: after }] = await api.db.db
      .select({ count: count() })
      .from(organizations);
    expect(after).toBe(before);
  });

  test("validation failures are 406, keyed by field", async () => {
    const short = await call(u.url, null, "PUT", "/user", {
      name: "Kamek",
      email: "kamek@koopa.troop",
      password: "short",
    });
    expect(short.status).toBe(406);
    expect(short.body.error?.key).toBe("password");
  });
});

describe("me:view and user:edit", () => {
  test("me:view answers the signed-in person, and 401 when signed out", async () => {
    const me = await call<{ user: { email: string } }>(
      u.url,
      u.mario,
      "GET",
      "/me",
    );
    expect(me.body.user.email).toBe(u.mario.email);
    expect((await call(u.url, null, "GET", "/me")).status).toBe(401);
  });

  test("edits only the caller, refuses a taken email, and changes the password", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Pauline",
      "pauline@new.donk",
    );
    const taken = await call(u.url, person, "POST", "/user", {
      email: u.peach.email,
      currentPassword: TEST_PASSWORD,
    });
    expect(taken.status).toBe(406);
    expect(taken.body.error?.key).toBe("email");

    // A borrowed session cannot change the password without knowing it.
    for (const currentPassword of [undefined, "not-my-password"]) {
      const refused = await call(u.url, person, "POST", "/user", {
        password: "new-donk-city",
        ...(currentPassword ? { currentPassword } : {}),
      });
      expect(refused.status).toBe(406);
      expect(refused.body.error?.key).toBe("currentPassword");
    }

    const edited = await call<{ user: { name: string } }>(
      u.url,
      person,
      "POST",
      "/user",
      {
        name: "Mayor Pauline",
        password: "new-donk-city",
        currentPassword: TEST_PASSWORD,
      },
    );
    expect(edited.body.user.name).toBe("Mayor Pauline");

    const old = await call(u.url, null, "PUT", "/session", {
      email: person.email,
      password: "password123",
    });
    expect(old.status).not.toBe(200);
    const fresh = await call(u.url, null, "PUT", "/session", {
      email: person.email,
      password: "new-donk-city",
    });
    expect(fresh.status).toBe(200);

    // The account row is tenant-less, and never carries the password.
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "user:edit"), isNull(auditLogs.projectId)),
      );
    expect(JSON.stringify(row.metadata)).not.toContain("new-donk-city");
    expect(JSON.stringify(row.metadata)).not.toContain(TEST_PASSWORD);
  });
});

describe("session:create and session:destroy", () => {
  test("an unknown email and a wrong password read the same", async () => {
    const unknown = await call(u.url, null, "PUT", "/session", {
      email: "nobody@nowhere.example",
      password: "password123",
    });
    const wrong = await call(u.url, null, "PUT", "/session", {
      email: u.peach.email,
      password: "not-the-password",
    });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error?.message).toBe(wrong.body.error?.message);
  });

  test("signing out ends the session", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Cranky",
      "cranky@kong.island",
    );
    expect((await call(u.url, person, "DELETE", "/session")).status).toBe(200);
    expect((await call(u.url, person, "GET", "/me")).status).toBe(401);
  });
});
