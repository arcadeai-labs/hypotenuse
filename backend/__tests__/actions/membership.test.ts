import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { MembershipList } from "../../actions/membership/membership-list";
import { getAdminUserIds } from "../../ops/MembershipOps";
import { projectMemberships } from "../../schema/project_memberships";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";
import {
  buildTestUniverse,
  call,
  createUserAndLogin,
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

describe("membership:list", () => {
  test("lists members by name with their tags in this project only", async () => {
    const { status, body } = await call<ActionResponse<MembershipList>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/members`,
    );
    expect(status).toBe(200);
    expect(
      body.memberships.map((m) => [m.user.name, m.tags.map((t) => t.name)]),
    ).toEqual([
      ["Luigi", ["viewers"]],
      ["Mario", ["operators"]],
      ["Peach", ["admin"]],
      ["Toad", []],
    ]);
    expect(body.pagination).toEqual({ page: 1, limit: 25, total: 4, pages: 1 });
  });

  test("paginates", async () => {
    const { body } = await call<ActionResponse<MembershipList>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/members?limit=2&page=2`,
    );
    expect(body.memberships.map((m) => m.user.name)).toEqual(["Peach", "Toad"]);
    expect(body.pagination.pages).toBe(2);
  });
});

describe("membership:create", () => {
  test("refuses someone outside the organization, naming the next move", async () => {
    const res = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member`,
      {
        email: u.bowser.email,
      },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain(
      "Invite them to the organization",
    );
    // An unknown address reads the same, so this cannot probe for accounts.
    const unknown = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member`,
      {
        email: "nobody@nowhere.example",
      },
    );
    expect(unknown.body.error?.message).toBe(res.body.error?.message);
  });

  test("adds a member of the organization, case-insensitively", async () => {
    const res = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member`,
      {
        email: "DAISY@sarasa.land",
      },
    );
    expect(res.status).toBe(200);
    const again = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/member`,
      {
        email: u.daisy.email,
      },
    );
    expect(again.status).toBe(406);
    expect(again.body.error?.message).toContain("already a member");
  });

  test("requires admin standing", async () => {
    const res = await call(
      u.url,
      u.mario,
      "PUT",
      `/project/${u.projectId}/member`,
      {
        email: u.daisy.email,
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("membership:delete", () => {
  test("removes the member and every tag they held in the project", async () => {
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/member/${u.mario.userId}`,
    );
    expect(res.status).toBe(200);
    const held = await api.db.db
      .select()
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .where(
        and(
          eq(userTags.userId, u.mario.userId),
          eq(tags.projectId, u.projectId),
        ),
      );
    expect(held).toEqual([]);
    const view = await call(u.url, u.mario, "GET", `/project/${u.projectId}`);
    expect(view.status).toBe(403);
    // He is still in the organization.
    const org = await call(
      u.url,
      u.mario,
      "GET",
      `/organization/${u.organizationId}`,
    );
    expect(org.status).toBe(200);
  });

  test("refuses the project's last explicit admin", async () => {
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/member/${u.peach.userId}`,
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain("last admin");
  });

  test("holds when two admins remove each other at once", async () => {
    // Two explicit admins of a fresh project, removing each other in the same
    // instant. Without `FOR UPDATE` on the project row both read two admins,
    // both pass, and the project is left with none.
    for (let round = 0; round < 5; round++) {
      const owner = await createUserAndLogin(
        u.url,
        "Wario",
        `wario${round}@ware.inc`,
      );
      const other = await createUserAndLogin(
        u.url,
        "Waluigi",
        `waluigi${round}@ware.inc`,
      );
      const projectId = owner.projectId;
      const admin = (
        await api.db.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.projectId, projectId), eq(tags.name, "admin")))
      )[0].id;
      const invited = await call<{ invite: { id: number } }>(
        u.url,
        owner,
        "PUT",
        `/organization/${owner.organizationId}/invite`,
        { projectId, inviteeEmail: other.email, tagIds: [admin] },
      );
      await call(
        u.url,
        other,
        "POST",
        `/invite/${invited.body.invite.id}/accept`,
      );

      const results = await Promise.all([
        call(
          u.url,
          owner,
          "DELETE",
          `/project/${projectId}/member/${other.userId}`,
        ),
        call(
          u.url,
          other,
          "DELETE",
          `/project/${projectId}/member/${owner.userId}`,
        ),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 406]).toContain(statuses[1]);
      expect(
        (await getAdminUserIds(api.db.db, projectId)).length,
        `round ${round}`,
      ).toBe(1);
      const left = await api.db.db
        .select()
        .from(projectMemberships)
        .where(eq(projectMemberships.projectId, projectId));
      expect(left.length).toBe(1);
    }
  });
});
