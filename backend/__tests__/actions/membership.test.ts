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

describe("granting a tag while the member is being removed", () => {
  test("never leaves a grant on someone who is no longer a member", async () => {
    // A grant of `admin` and a removal of the same person, sent at once. The
    // grant locks the project row before it reads the membership, so it either
    // lands before the removal (which then takes it away) or finds the
    // membership gone. A grant left behind would count as an admin the
    // last-admin guard trusts, on someone who is not in the project.
    for (let round = 0; round < 5; round++) {
      const owner = await createUserAndLogin(
        u.url,
        "Kong",
        `kong${round}@jungle.example`,
      );
      const newbie = await createUserAndLogin(
        u.url,
        "Diddy",
        `diddy${round}@jungle.example`,
      );
      const projectId = owner.projectId;
      const sent = await call<{ invite: { id: number } }>(
        u.url,
        owner,
        "PUT",
        `/organization/${owner.organizationId}/invite`,
        { projectId, inviteeEmail: newbie.email },
      );
      await call(
        u.url,
        newbie,
        "POST",
        `/invite/${sent.body.invite.id}/accept`,
      );
      const [admin] = await api.db.db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.projectId, projectId), eq(tags.name, "admin")));

      await Promise.all([
        call(
          u.url,
          owner,
          "PUT",
          `/project/${projectId}/member/${newbie.userId}/tag/${admin.id}`,
        ),
        call(
          u.url,
          owner,
          "DELETE",
          `/project/${projectId}/member/${newbie.userId}`,
        ),
      ]);

      const member = await api.db.db
        .select()
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, projectId),
            eq(projectMemberships.userId, newbie.userId),
          ),
        );
      const grants = await api.db.db
        .select()
        .from(userTags)
        .where(
          and(eq(userTags.userId, newbie.userId), eq(userTags.tagId, admin.id)),
        );
      expect(member.length === 0 && grants.length > 0, `round ${round}`).toBe(
        false,
      );

      // And the owner is still the project's one admin, so cannot leave it.
      const leave = await call(
        u.url,
        owner,
        "DELETE",
        `/project/${projectId}/member/${owner.userId}`,
      );
      if (member.length === 0) expect(leave.status, `round ${round}`).toBe(406);
    }
  }, 60_000);
});

describe("removing a member from a project", () => {
  test("withdraws their pending invites into it, so one is not a way back", async () => {
    // Luigi is in Castle; an invite back into it sits pending when he is removed.
    const sent = await call<{ invite: { id: number } }>(
      u.url,
      u.peach,
      "PUT",
      `/organization/${u.organizationId}/invite`,
      { projectId: u.projectId, inviteeEmail: u.luigi.email },
    );
    const removed = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/member/${u.luigi.userId}`,
    );
    expect(removed.status).toBe(200);

    const accept = await call(
      u.url,
      u.luigi,
      "POST",
      `/invite/${sent.body.invite.id}/accept`,
    );
    expect(accept.status).toBe(406);
    expect(accept.body.error?.message).toContain("withdrawn");
    expect(
      (await call(u.url, u.luigi, "GET", `/project/${u.projectId}`)).status,
    ).toBe(403);

    const list = await call<{ invites: { id: number; status: string }[] }>(
      u.url,
      u.peach,
      "GET",
      `/project/${u.projectId}/invites`,
    );
    expect(
      list.body.invites.find((i) => i.id === sent.body.invite.id)?.status,
    ).toBe("revoked");
  });
});
