import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { TagList } from "../../actions/tag/tag-list";
import { auditLogs } from "../../schema/audit_logs";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The id of the project's reserved `admin` tag.
 * @returns The tag id.
 */
async function adminTagId(): Promise<number> {
  const { body } = await call<ActionResponse<TagList>>(
    u.url,
    u.peach,
    "GET",
    `/project/${u.projectId}/tags`,
  );
  return body.tags.find((t) => t.reserved)!.id;
}

describe("tag:list", () => {
  test("every member sees the vocabulary, by name, with the reserved tag marked", async () => {
    const { status, body } = await call<ActionResponse<TagList>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/tags`,
    );
    expect(status).toBe(200);
    expect(body.tags.map((t) => [t.name, t.reserved])).toEqual([
      ["admin", true],
      ["operators", false],
      ["viewers", false],
    ]);
  });
});

describe("tag:create / tag:edit / tag:delete", () => {
  test("the reserved name cannot be created, in any spelling", async () => {
    for (const name of ["admin", " Admin ", "ADMIN"]) {
      const res = await call(
        u.url,
        u.peach,
        "PUT",
        `/project/${u.projectId}/tag`,
        {
          name,
        },
      );
      expect(res.status, name).toBe(406);
      expect(res.body.error?.key).toBe("name");
    }
  });

  test("names are unique per project ignoring case and whitespace", async () => {
    const res = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/tag`,
      {
        name: " Operators",
      },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain("already exists");
    // The same name in another project is fine.
    const elsewhere = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.peach.projectId}/tag`,
      { name: "operators" },
    );
    expect(elsewhere.status).toBe(200);
  });

  test("the reserved tag cannot be renamed or deleted, and nothing can be renamed to it", async () => {
    const admin = await adminTagId();
    const rename = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${admin}`,
      {
        name: "boss",
      },
    );
    expect(rename.status).toBe(406);
    const del = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${admin}`,
    );
    expect(del.status).toBe(406);
    const impersonate = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
      { name: "Admin" },
    );
    expect(impersonate.status).toBe(406);
  });

  test("renames a tag", async () => {
    const res = await call<{ tag: { name: string } }>(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
      { name: "watchers" },
    );
    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe("watchers");
  });

  test("a tag of one project cannot be touched through another", async () => {
    const res = await call(
      u.url,
      u.bowser,
      "DELETE",
      `/project/${u.bowser.projectId}/tag/${u.tagIds.operators}`,
    );
    expect(res.status).toBe(404);
  });

  test("deleting a tag revokes it, and the audit row names whom from", async () => {
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${u.tagIds.operators}`,
    );
    expect(res.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tag:delete"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.metadata.revokedFromUserIds).toEqual([u.mario.userId]);
  });
});

describe("user-tag:assign / user-tag:remove", () => {
  test("grants and revokes idempotently", async () => {
    const path = `/project/${u.projectId}/member/${u.toad.userId}/tag/${u.tagIds.viewers}`;
    expect((await call(u.url, u.peach, "PUT", path)).status).toBe(200);
    expect((await call(u.url, u.peach, "PUT", path)).status).toBe(200);
    const view = await call<{ callerTags: { name: string }[] }>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(view.body.callerTags.map((t) => t.name)).toEqual(["watchers"]);
    expect((await call(u.url, u.peach, "DELETE", path)).status).toBe(200);
    expect((await call(u.url, u.peach, "DELETE", path)).status).toBe(200);
  });

  test("refuses someone who is not a member of the project", async () => {
    const res = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member/${u.daisy.userId}/tag/${u.tagIds.viewers}`,
    );
    expect(res.status).toBe(406);
  });

  test("refuses revoking admin from the last admin, and allows it once there is another", async () => {
    const admin = await adminTagId();
    const last = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/member/${u.peach.userId}/tag/${admin}`,
    );
    expect(last.status).toBe(406);
    expect(last.body.error?.message).toContain("last admin");

    await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member/${u.toad.userId}/tag/${admin}`,
    );
    const now = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/member/${u.peach.userId}/tag/${admin}`,
    );
    expect(now.status).toBe(200);
    // Peach still owns the organization, so she keeps admin standing.
    const view = await call<{
      standing: { isAdmin: boolean; viaOrganizationOwner: boolean };
    }>(u.url, u.peach, "GET", `/project/${u.projectId}`);
    expect(view.body.standing).toMatchObject({
      isAdmin: true,
      viaOrganizationOwner: true,
    });
  });
});

describe('a tag named "*"', () => {
  test("is refused, because * means every member in an access list", async () => {
    const create = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/tag`,
      {
        name: " * ",
      },
    );
    expect(create.status).toBe(406);
    const rename = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${u.tagIds.viewers}`,
      { name: "*" },
    );
    expect(rename.status).toBe(406);
    expect(rename.body.error?.key).toBe("name");
  });
});
