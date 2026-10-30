import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { MembershipList } from "../../actions/membership/membership-list";
import type { OrganizationList } from "../../actions/organization/organization-list";
import type { OrganizationView } from "../../actions/organization/organization-view";
import type { OrganizationMembershipList } from "../../actions/organization-membership/organization-membership-list";
import type { ProjectList } from "../../actions/project/project-list";
import type { ProjectView } from "../../actions/project/project-view";
import { auditLogs } from "../../schema/audit_logs";
import { organizationMemberships } from "../../schema/organization_memberships";
import { projectMemberships } from "../../schema/project_memberships";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";
import {
  buildTestUniverse,
  call,
  createUserAndLogin,
  HOOK_TIMEOUT,
  inviteAndAccept,
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
 * The names of the projects a person can see, through `project:list`.
 * @param user - Who is asking.
 * @param organizationId - Narrow to one organization.
 * @returns The project names, sorted.
 */
async function visibleProjects(
  user: TestUniverse["peach"],
  organizationId?: number,
): Promise<string[]> {
  const { body } = await call<ActionResponse<ProjectList>>(
    u.url,
    user,
    "GET",
    `/projects${organizationId ? `?organizationId=${organizationId}` : ""}`,
  );
  return body.projects.map((p) => p.name).sort();
}

describe("sign-up", () => {
  test("creates an organization named after the person, which they own, with a Default project", async () => {
    const { body } = await call<ActionResponse<OrganizationList>>(
      u.url,
      u.bowser,
      "GET",
      "/organizations",
    );
    expect(body.organizations.map((o) => [o.name, o.standing.role])).toEqual([
      ["Koopa Troop", "owner"],
    ]);
    expect(await visibleProjects(u.bowser)).toEqual(["Default"]);
  });

  test("a second person with the same name gets a distinct slug", async () => {
    const twin = await createUserAndLogin(
      u.url,
      "Bowser",
      "bowser@castle.koopa",
    );
    const { body } = await call<ActionResponse<OrganizationView>>(
      u.url,
      twin,
      "GET",
      `/organization/${twin.organizationId}`,
    );
    // The first Bowser's organization was renamed Koopa Troop, and its slug
    // stayed `bowser-s-org`: a slug never follows a rename on its own.
    expect(body.organization.slug).toBe("bowser-s-org-2");
  });
});

describe("visibility", () => {
  test("a member sees only the projects they belong to", async () => {
    expect(await visibleProjects(u.mario, u.organizationId)).toEqual([
      "Castle",
    ]);
  });

  test("an organization member with no project sees none of its projects", async () => {
    expect(await visibleProjects(u.daisy, u.organizationId)).toEqual([]);
    const view = await call(u.url, u.daisy, "GET", `/project/${u.projectId}`);
    expect(view.status).toBe(403);
    // …but does see the organization itself.
    const org = await call<ActionResponse<OrganizationView>>(
      u.url,
      u.daisy,
      "GET",
      `/organization/${u.organizationId}`,
    );
    expect(org.status).toBe(200);
    expect(org.body.standing).toEqual({
      isMember: true,
      isOwner: false,
      role: "member",
    });
  });

  test("an owner sees every project of the organization", async () => {
    expect(await visibleProjects(u.peach, u.organizationId)).toEqual([
      "Castle",
      "Default",
    ]);
  });

  test("an outsider sees nothing of the organization", async () => {
    expect(await visibleProjects(u.bowser, u.organizationId)).toEqual([]);
    const members = await call(
      u.url,
      u.bowser,
      "GET",
      `/organization/${u.organizationId}/members`,
    );
    expect(members.status).toBe(403);
  });

  test("organization members are listed with roles, owners first", async () => {
    const { body } = await call<ActionResponse<OrganizationMembershipList>>(
      u.url,
      u.daisy,
      "GET",
      `/organization/${u.organizationId}/members`,
    );
    expect(body.memberships.map((m) => [m.user.name, m.role])).toEqual([
      ["Peach", "owner"],
      ["Daisy", "member"],
      ["Luigi", "member"],
      ["Mario", "member"],
      ["Toad", "member"],
    ]);
    expect(body.pagination.total).toBe(5);
  });
});

describe("an owner's admin standing in every project", () => {
  test("is computed without a project membership, and flagged", async () => {
    // Make Toad an owner. He is a plain member of Castle, and not in Default.
    const promoted = await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}/member/${u.toad.userId}`,
      { role: "owner" },
    );
    expect(promoted.status).toBe(200);

    const view = await call<ActionResponse<ProjectView>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.peach.projectId}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.standing).toEqual({
      isMember: true,
      isAdmin: true,
      viaOrganizationOwner: true,
    });
    // Standing is not a grant: the synthetic admin tag is not listed as held.
    expect(view.body.callerTags).toEqual([]);

    // And in Castle, where he is a member without the admin tag.
    const castle = await call<ActionResponse<ProjectView>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(castle.body.standing.viaOrganizationOwner).toBe(true);
  });

  test("lets an owner act as admin, and the audit row says under which standing", async () => {
    const created = await call<{ tag: { id: number } }>(
      u.url,
      u.toad,
      "PUT",
      `/project/${u.peach.projectId}/tag`,
      { name: "mushrooms" },
    );
    expect(created.status).toBe(200);

    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "tag:create"),
          eq(auditLogs.projectId, u.peach.projectId),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.userId).toBe(u.toad.userId);
    expect(row.metadata.standing).toBe("organization-owner");

    // An explicit admin's row carries no such note.
    await call(u.url, u.peach, "PUT", `/project/${u.peach.projectId}/tag`, {
      name: "stars",
    });
    const [own] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tag:create"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(own.userId).toBe(u.peach.userId);
    expect(own.metadata.standing).toBeUndefined();
  });

  test("ends the moment they stop being an owner", async () => {
    const demoted = await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}/member/${u.toad.userId}`,
      { role: "member" },
    );
    expect(demoted.status).toBe(200);
    const view = await call(
      u.url,
      u.toad,
      "GET",
      `/project/${u.peach.projectId}`,
    );
    expect(view.status).toBe(403);
  });
});

describe("only owners administer the organization", () => {
  test("a member cannot rename, delete, create a project in, or list its invites", async () => {
    for (const [method, path, body] of [
      ["POST", `/organization/${u.organizationId}`, { name: "Mario Land" }],
      ["DELETE", `/organization/${u.organizationId}`, undefined],
      ["PUT", "/project", { organizationId: u.organizationId, name: "Pipes" }],
      ["GET", `/organization/${u.organizationId}/invites`, undefined],
      [
        "POST",
        `/organization/${u.organizationId}/member/${u.luigi.userId}`,
        { role: "owner" },
      ],
    ] as const) {
      const res = await call(u.url, u.mario, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test("a member cannot remove someone else, but can leave", async () => {
    const someone = await call(
      u.url,
      u.mario,
      "DELETE",
      `/organization/${u.organizationId}/member/${u.luigi.userId}`,
    );
    expect(someone.status).toBe(403);
  });

  test("deleting an organization is refused while it has projects", async () => {
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/organization/${u.organizationId}`,
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain("2 projects");
  });

  test("an empty organization can be created and deleted by its owner", async () => {
    const created = await call<{ organization: { id: number } }>(
      u.url,
      u.mario,
      "PUT",
      "/organization",
      { name: "Plumbing Co" },
    );
    expect(created.status).toBe(200);
    const id = created.body.organization.id;
    const deleted = await call(u.url, u.mario, "DELETE", `/organization/${id}`);
    expect(deleted.status).toBe(200);
    const gone = await call(u.url, u.mario, "GET", `/organization/${id}`);
    expect(gone.status).toBe(403);
  });

  test("a slug is validated and unique", async () => {
    const bad = await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}`,
      {
        slug: "Not A Slug",
      },
    );
    expect(bad.status).toBe(406);
    const taken = await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}`,
      {
        slug: "bowser-s-org",
      },
    );
    expect(taken.status).toBe(406);
    const ok = await call<{ organization: { slug: string } }>(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}`,
      { slug: "mushroom-kingdom" },
    );
    expect(ok.body.organization.slug).toBe("mushroom-kingdom");
  });
});

describe("the last-owner guard", () => {
  test("refuses demoting or removing the last owner", async () => {
    const demote = await call(
      u.url,
      u.bowser,
      "POST",
      `/organization/${u.koopaOrganizationId}/member/${u.bowser.userId}`,
      { role: "member" },
    );
    expect(demote.status).toBe(406);
    expect(demote.body.error?.message).toContain("last owner");
    const leave = await call(
      u.url,
      u.bowser,
      "DELETE",
      `/organization/${u.koopaOrganizationId}/member/${u.bowser.userId}`,
    );
    expect(leave.status).toBe(406);
  });

  test("holds when two owners demote each other at once", async () => {
    // Two owners of a fresh organization, each demoting the other in the same
    // instant. Without `FOR UPDATE` on the organization row both read two
    // owners, both pass, and the organization is left with none.
    for (let round = 0; round < 5; round++) {
      const kamek = await createUserAndLogin(
        u.url,
        "Kamek",
        `kamek${round}@koopa.troop`,
      );
      const kammy = await createUserAndLogin(
        u.url,
        "Kammy",
        `kammy${round}@koopa.troop`,
      );
      const orgId = kamek.organizationId;
      await inviteAndAccept(u.url, kamek, orgId, null, kammy);
      await call(
        u.url,
        kamek,
        "POST",
        `/organization/${orgId}/member/${kammy.userId}`,
        {
          role: "owner",
        },
      );

      const results = await Promise.all([
        call(
          u.url,
          kamek,
          "POST",
          `/organization/${orgId}/member/${kammy.userId}`,
          {
            role: "member",
          },
        ),
        call(
          u.url,
          kammy,
          "POST",
          `/organization/${orgId}/member/${kamek.userId}`,
          {
            role: "member",
          },
        ),
      ]);
      const statuses = results.map((r) => r.status).sort();
      // Either one wins and the other is refused, or the second ran after the
      // first demoted its caller and so is no longer an owner at all.
      expect(statuses[0]).toBe(200);
      expect([403, 406]).toContain(statuses[1]);

      const owners = await api.db.db
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, orgId),
            eq(organizationMemberships.role, "owner"),
          ),
        );
      expect(owners.length, `round ${round}`).toBe(1);
    }
  });
});

describe("removing someone from an organization", () => {
  test("removes every project membership and tag they held there, in one transaction", async () => {
    // Luigi: a member of Castle with `viewers`. Add him to Default too.
    await call(u.url, u.peach, "PUT", `/project/${u.peach.projectId}/member`, {
      email: u.luigi.email,
    });

    const removed = await call<{ removedFromProjectIds: number[] }>(
      u.url,
      u.peach,
      "DELETE",
      `/organization/${u.organizationId}/member/${u.luigi.userId}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.removedFromProjectIds.sort()).toEqual(
      [u.projectId, u.peach.projectId].sort(),
    );

    const memberships = await api.db.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, u.luigi.userId));
    // Only his own sign-up project remains.
    expect(memberships.map((m) => m.projectId)).toEqual([u.luigi.projectId]);

    const heldTags = await api.db.db
      .select({ projectId: tags.projectId })
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .where(eq(userTags.userId, u.luigi.userId));
    expect(heldTags.map((t) => t.projectId)).toEqual([u.luigi.projectId]);

    // Each project's own log records that he left it.
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "membership:delete"));
    expect(rows.map((r) => r.projectId).sort()).toEqual(
      [u.projectId, u.peach.projectId].sort(),
    );
    expect(rows.every((r) => r.metadata.cascadedFrom)).toBe(true);

    const castle = await call<ActionResponse<MembershipList>>(
      u.url,
      u.peach,
      "GET",
      `/project/${u.projectId}/members`,
    );
    expect(castle.body.memberships.map((m) => m.user.name)).not.toContain(
      "Luigi",
    );
  });

  test("refuses to remove someone who is the last explicit admin of one of its projects", async () => {
    // Daisy joins the organization's owners, creates a project (its only
    // admin), and is then demoted. Removing her would leave Garden with no one
    // holding its admin tag.
    await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}/member/${u.daisy.userId}`,
      {
        role: "owner",
      },
    );
    const garden = await call<{ project: { id: number } }>(
      u.url,
      u.daisy,
      "PUT",
      "/project",
      {
        organizationId: u.organizationId,
        name: "Garden",
      },
    );
    expect(garden.status).toBe(200);
    await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}/member/${u.daisy.userId}`,
      {
        role: "member",
      },
    );

    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/organization/${u.organizationId}/member/${u.daisy.userId}`,
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain('"Garden"');

    // Nothing moved: she is still in the organization and the project.
    const still = await api.db.db
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, u.daisy.userId),
          eq(projectMemberships.projectId, garden.body.project.id),
        ),
      );
    expect(still.length).toBe(1);
  });

  test("a member can leave", async () => {
    const res = await call(
      u.url,
      u.mario,
      "DELETE",
      `/organization/${u.organizationId}/member/${u.mario.userId}`,
    );
    expect(res.status).toBe(200);
    expect(await visibleProjects(u.mario, u.organizationId)).toEqual([]);
    const org = await call(
      u.url,
      u.mario,
      "GET",
      `/organization/${u.organizationId}`,
    );
    expect(org.status).toBe(403);
  });
});

describe("pending invites when someone is removed from the organization", () => {
  test("are withdrawn, so a stale invite is not a way back in", async () => {
    const wario = await createUserAndLogin(
      u.url,
      "Wario",
      "wario@mushroom.kingdom",
    );
    await inviteAndAccept(u.url, u.peach, u.organizationId, null, wario);
    const pending = await call<{ invite: { id: number } }>(
      u.url,
      u.peach,
      "PUT",
      `/organization/${u.organizationId}/invite`,
      { projectId: u.projectId, inviteeEmail: wario.email },
    );

    const removed = await call(
      u.url,
      u.peach,
      "DELETE",
      `/organization/${u.organizationId}/member/${wario.userId}`,
    );
    expect(removed.status).toBe(200);

    const accept = await call(
      u.url,
      wario,
      "POST",
      `/invite/${pending.body.invite.id}/accept`,
    );
    expect(accept.status).toBe(406);
    expect(
      (await call(u.url, wario, "GET", `/organization/${u.organizationId}`))
        .status,
    ).toBe(403);
    expect(
      (await call(u.url, wario, "GET", `/project/${u.projectId}`)).status,
    ).toBe(403);
  });
});

describe("an owner demoted while acting", () => {
  test("cannot finish removing someone once the demotion has committed", async () => {
    // Two owners: one demotes the other while the other removes a member. Both
    // take the organization lock, and the remover re-reads their role under it,
    // so a removal that runs after the demotion is refused.
    for (let round = 0; round < 6; round++) {
      const a = await createUserAndLogin(
        u.url,
        "King K",
        `kingk${round}@kremling.example`,
      );
      const b = await createUserAndLogin(
        u.url,
        "Klump",
        `klump${round}@kremling.example`,
      );
      const c = await createUserAndLogin(
        u.url,
        "Krusha",
        `krusha${round}@kremling.example`,
      );
      const orgId = a.organizationId;
      await inviteAndAccept(u.url, a, orgId, null, b);
      await inviteAndAccept(u.url, a, orgId, null, c);
      await call(
        u.url,
        a,
        "POST",
        `/organization/${orgId}/member/${b.userId}`,
        {
          role: "owner",
        },
      );

      const [demote, remove] = await Promise.all([
        call(u.url, a, "POST", `/organization/${orgId}/member/${b.userId}`, {
          role: "member",
        }),
        call(u.url, b, "DELETE", `/organization/${orgId}/member/${c.userId}`),
      ]);
      expect(demote.status, `round ${round}`).toBe(200);
      if (remove.status === 200) {
        // Allowed only if the removal committed first: its audit row is older.
        const rows = await api.db.db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.userId, b.userId))
          .orderBy(desc(auditLogs.id));
        const removal = rows.find(
          (r) => r.action === "organization-membership:delete",
        );
        const [demotion] = await api.db.db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.userId, a.userId),
              eq(auditLogs.action, "organization-membership:edit"),
            ),
          )
          .orderBy(desc(auditLogs.id))
          .limit(1);
        expect(removal!.id, `round ${round}`).toBeLessThan(demotion.id);
      } else {
        expect(remove.status, `round ${round}`).toBe(403);
      }
    }
  }, 60_000);
});
