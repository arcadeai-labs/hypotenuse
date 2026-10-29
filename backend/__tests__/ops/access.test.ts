import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, jsonb, pgTable, serial, text } from "drizzle-orm/pg-core";
import { api } from "keryx";
import {
  ACCESS_EVERYONE,
  type AccessListTable,
  accessListSchema,
  assertAccessListTags,
  canRead,
  canWrite,
  readableIds,
  registerAccessListTable,
  satisfiesAccess,
  unregisterAccessListTable,
} from "../../ops/AccessOps";
import { resolveProjectAccess } from "../../ops/MembershipOps";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * A table that exists only in the test database. The first real holder of
 * access lists is a bot, which does not exist yet; this stands in for it with
 * exactly the columns `AccessOps` reads.
 */
const widgets = pgTable("access_test_widgets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  accessRead: jsonb("access_read").$type<string[]>().notNull(),
  accessWrite: jsonb("access_write").$type<string[]>().notNull(),
});

/** The test table, as `AccessOps` knows it. */
const WIDGETS: AccessListTable = {
  kind: "widget",
  table: widgets,
  id: widgets.id,
  projectId: widgets.projectId,
  label: widgets.name,
  accessRead: widgets.accessRead,
  accessWrite: widgets.accessWrite,
};

let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
  await api.db.db.execute(sql`DROP TABLE IF EXISTS access_test_widgets`);
  await api.db.db.execute(sql`
    CREATE TABLE access_test_widgets (
      id serial PRIMARY KEY,
      project_id integer NOT NULL,
      name text NOT NULL,
      access_read jsonb NOT NULL,
      access_write jsonb NOT NULL
    )`);
  registerAccessListTable(WIDGETS);
}, HOOK_TIMEOUT);

afterAll(async () => {
  unregisterAccessListTable("widget");
  await api.db.db.execute(sql`DROP TABLE IF EXISTS access_test_widgets`);
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A person's tags in Castle, resolved the way the RBAC middleware resolves them.
 * @param user - Who.
 * @returns Their tags (an owner's include the synthetic admin row).
 */
async function tagsOf(user: TestUser) {
  const access = await resolveProjectAccess(user.userId, u.projectId);
  if (!access) throw new Error(`${user.name} has no access to Castle`);
  return access.callerTags;
}

/**
 * Set Daisy's role in the Mushroom Kingdom.
 * @param role - The role to give her.
 */
async function setDaisyRole(role: "owner" | "member") {
  const res = await call(
    u.url,
    u.peach,
    "POST",
    `/organization/${u.organizationId}/member/${u.daisy.userId}`,
    { role },
  );
  expect(res.status).toBe(200);
}

describe("satisfiesAccess: one test per row of the table", () => {
  test("any list, caller is admin: passes", async () => {
    const peach = await tagsOf(u.peach);
    for (const list of [[], ["*"], ["operators"], ["nobody-holds-this"]]) {
      expect(satisfiesAccess(list, peach), JSON.stringify(list)).toBe(true);
    }
  });

  test("any list, caller owns the organization but never joined the project: passes", async () => {
    await setDaisyRole("owner");
    expect(satisfiesAccess(["nobody-holds-this"], await tagsOf(u.daisy))).toBe(
      true,
    );
    await setDaisyRole("member");
    expect(await resolveProjectAccess(u.daisy.userId, u.projectId)).toBeNull();
  });

  test("an empty list: every member passes", async () => {
    expect(satisfiesAccess([], await tagsOf(u.toad))).toBe(true);
  });

  test(`a list containing "${ACCESS_EVERYONE}": every member passes`, async () => {
    const toad = await tagsOf(u.toad);
    expect(satisfiesAccess(["operators", "*"], toad)).toBe(true);
    expect(satisfiesAccess([" * "], toad)).toBe(true);
  });

  test("tag names: holders of any named tag pass, case-insensitively and trimmed", async () => {
    const mario = await tagsOf(u.mario);
    const luigi = await tagsOf(u.luigi);
    const toad = await tagsOf(u.toad);
    expect(satisfiesAccess(["operators"], mario)).toBe(true);
    expect(satisfiesAccess([" OPERATORS "], mario)).toBe(true);
    expect(satisfiesAccess(["operators", "viewers"], luigi)).toBe(true);
    expect(satisfiesAccess(["operators"], luigi)).toBe(false);
    expect(satisfiesAccess(["operators"], toad)).toBe(false);
  });

  test("canRead and canWrite each read their own list", async () => {
    const row = { accessRead: ["viewers"], accessWrite: ["operators"] };
    const luigi = await tagsOf(u.luigi);
    expect(canRead(row, luigi)).toBe(true);
    expect(canWrite(row, luigi)).toBe(false);
  });
});

describe("readableIds", () => {
  test("resolves the readable rows of one project, for a page to filter on", async () => {
    const rows = await api.db.db
      .insert(widgets)
      .values([
        {
          projectId: u.projectId,
          name: "open",
          accessRead: [],
          accessWrite: [],
        },
        {
          projectId: u.projectId,
          name: "ops",
          accessRead: ["operators"],
          accessWrite: [],
        },
        {
          projectId: u.projectId,
          name: "view",
          accessRead: ["viewers"],
          accessWrite: [],
        },
        {
          projectId: u.peach.projectId,
          name: "elsewhere",
          accessRead: [],
          accessWrite: [],
        },
      ])
      .returning();
    const id = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    const as = async (user: TestUser) =>
      (
        await readableIds(api.db.db, WIDGETS, u.projectId, await tagsOf(user))
      ).sort();
    expect(await as(u.mario)).toEqual([id.open, id.ops].sort());
    expect(await as(u.peach)).toEqual([id.open, id.ops, id.view].sort());
    await api.db.db.delete(widgets);
  });
});

describe("accessListSchema and assertAccessListTags", () => {
  test("normalizes and dedupes, and refuses an empty entry", () => {
    expect(accessListSchema.parse([" Operators", "operators", "*"])).toEqual([
      "operators",
      "*",
    ]);
    expect(accessListSchema.safeParse([""]).success).toBe(false);
  });

  test("refuses a name that is not a tag of the project, naming it", async () => {
    await expect(
      assertAccessListTags(
        api.db.db,
        u.projectId,
        ["operators", "*"],
        "accessRead",
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertAccessListTags(
        api.db.db,
        u.projectId,
        ["operators", "finance"],
        "accessRead",
      ),
    ).rejects.toThrow('"finance"');
  });
});

describe("tags named in access lists", () => {
  test("tag:delete is refused while any list names the tag, naming the objects", async () => {
    const [row] = await api.db.db
      .insert(widgets)
      .values({
        projectId: u.projectId,
        name: "ledger",
        accessRead: ["*"],
        accessWrite: ["Viewers"],
      })
      .returning();

    const refused = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain('widget "ledger"');

    // Nothing changed: the list still says what it said.
    const [after] = await api.db.db
      .select()
      .from(widgets)
      .where(eq(widgets.id, row.id));
    expect(after.accessWrite).toEqual(["Viewers"]);

    // A tag no list names deletes fine.
    const free = await call<{ tag: { id: number } }>(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/tag`,
      { name: "unused" },
    );
    const deleted = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${free.body.tag.id}`,
    );
    expect(deleted.status).toBe(200);
  });

  test("tag:edit carries a rename into every list, so no one's access changes", async () => {
    const res = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
      { name: "Watchers" },
    );
    expect(res.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(widgets)
      .where(eq(widgets.name, "ledger"));
    expect(row.accessWrite).toEqual(["watchers"]);
    expect(row.accessRead).toEqual(["*"]);
    expect(canWrite(row, await tagsOf(u.luigi))).toBe(true);

    // And the delete is still refused, under the new name.
    const refused = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
    );
    expect(refused.status).toBe(406);
  });
});
