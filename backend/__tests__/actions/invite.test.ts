import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { InviteCreate } from "../../actions/invite/invite-create";
import type { InviteList } from "../../actions/invite/invite-list";
import type { InviteListPending } from "../../actions/invite/invite-list-pending";
import type { OrganizationInviteList } from "../../actions/organization/organization-invite-list";
import { organizationMemberships } from "../../schema/organization_memberships";
import { projectInvites } from "../../schema/project_invites";
import {
  buildTestUniverse,
  call,
  createUserAndLogin,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Send an invite and return the answer.
 * @param inviter - Who sends it.
 * @param body - `inviteeEmail`, and `projectId` / `tagIds` for a project invite.
 * @param organizationId - The organization (defaults to Mushroom Kingdom).
 * @returns The HTTP status and body.
 */
function invite(
  inviter: TestUser,
  body: Record<string, unknown>,
  organizationId = u.organizationId,
) {
  return call<ActionResponse<InviteCreate>>(
    u.url,
    inviter,
    "PUT",
    `/organization/${organizationId}/invite`,
    body,
  );
}

/**
 * The organizations a person belongs to, by id.
 * @param user - Who.
 * @returns Their organization ids.
 */
async function organizationsOf(user: TestUser): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.userId, user.userId));
  return rows.map((r) => r.id).sort();
}

describe("who may send which invite", () => {
  test("a project admin sends a project invite; a plain member may not", async () => {
    const ok = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: "yoshi@yoshi.island",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.invite).toMatchObject({
      kind: "project",
      organizationName: "Mushroom Kingdom",
      projectName: "Castle",
      status: "pending",
    });
    const refused = await invite(u.mario, {
      projectId: u.projectId,
      inviteeEmail: "yoshi@yoshi.island",
    });
    expect(refused.status).toBe(403);
  });

  test("only an owner sends an organization invite", async () => {
    const refused = await invite(u.mario, {
      inviteeEmail: "toadette@mushroom.kingdom",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toContain("owner");
    const ok = await invite(u.peach, {
      inviteeEmail: "toadette@mushroom.kingdom",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.invite).toMatchObject({
      kind: "organization",
      projectId: null,
    });
  });

  test("an organization invite cannot carry tags", async () => {
    const res = await invite(u.peach, {
      inviteeEmail: "toadsworth@mushroom.kingdom",
      tagIds: [u.tagIds.viewers],
    });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("tagIds");
  });

  test("tags must belong to the project", async () => {
    const res = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: "toadsworth@mushroom.kingdom",
      tagIds: [u.tagIds.viewers, 999_999],
    });
    expect(res.status).toBe(406);
  });

  test("a project in another organization is refused like one you cannot administer", async () => {
    // Bowser owns Koopa Troop and administers his own project, but naming his
    // project under Mushroom Kingdom — or Castle under Koopa Troop — is a 403.
    const theirs = await invite(
      u.bowser,
      { projectId: u.projectId, inviteeEmail: "kamek@koopa.troop" },
      u.koopaOrganizationId,
    );
    expect(theirs.status).toBe(403);
    const mismatched = await invite(u.peach, {
      projectId: u.bowser.projectId,
      inviteeEmail: "kamek@koopa.troop",
    });
    expect(mismatched.status).toBe(403);
  });
});

describe("accepting", () => {
  test("a project invite to someone outside the organization joins both, with the tags", async () => {
    const yoshi = await createUserAndLogin(
      u.url,
      "Yoshi",
      "yoshi@yoshi.island",
    );
    const sent = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: "Yoshi@Yoshi.Island",
      tagIds: [u.tagIds.viewers],
    });
    const pending = await call<ActionResponse<InviteListPending>>(
      u.url,
      yoshi,
      "GET",
      "/invites/pending",
    );
    expect(pending.body.invites.map((i) => i.id)).toContain(
      sent.body.invite.id,
    );

    const accepted = await call<{
      organizationMembership: { role: string };
      membership: { projectId: number };
    }>(u.url, yoshi, "POST", `/invite/${sent.body.invite.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.organizationMembership.role).toBe("member");
    expect(accepted.body.membership.projectId).toBe(u.projectId);
    expect(await organizationsOf(yoshi)).toEqual(
      [yoshi.organizationId, u.organizationId].sort(),
    );

    const view = await call<{ callerTags: { name: string }[] }>(
      u.url,
      yoshi,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(view.body.callerTags.map((t) => t.name)).toEqual(["viewers"]);
  });

  test("an organization invite joins only the organization", async () => {
    const toadette = await createUserAndLogin(
      u.url,
      "Toadette",
      "toadette@mushroom.kingdom",
    );
    const pending = await call<ActionResponse<InviteListPending>>(
      u.url,
      toadette,
      "GET",
      "/invites/pending",
    );
    const orgInvite = pending.body.invites.find(
      (i) => i.kind === "organization",
    )!;
    const res = await call<{ membership: unknown }>(
      u.url,
      toadette,
      "POST",
      `/invite/${orgInvite.id}/accept`,
    );
    expect(res.status).toBe(200);
    expect(res.body.membership).toBeNull();
    const projects = await call<{ projects: unknown[] }>(
      u.url,
      toadette,
      "GET",
      `/projects?organizationId=${u.organizationId}`,
    );
    expect(projects.body.projects).toEqual([]);
  });

  test("only the addressee can accept, and the refusal does not say the invite exists", async () => {
    const sent = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: "boo@ghost.house",
    });
    const stolen = await call(
      u.url,
      u.bowser,
      "POST",
      `/invite/${sent.body.invite.id}/accept`,
    );
    const missing = await call(
      u.url,
      u.bowser,
      "POST",
      "/invite/999999/accept",
    );
    expect(stolen.status).toBe(404);
    expect(stolen.body.error?.message).toBe(missing.body.error?.message);
  });

  test("an answered or expired invite cannot be accepted or rejected", async () => {
    const wiggler = await createUserAndLogin(
      u.url,
      "Wiggler",
      "wiggler@forest.maze",
    );
    const first = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: wiggler.email,
    });
    await call(
      u.url,
      wiggler,
      "POST",
      `/invite/${first.body.invite.id}/accept`,
    );
    const twice = await call(
      u.url,
      wiggler,
      "POST",
      `/invite/${first.body.invite.id}/accept`,
    );
    expect(twice.status).toBe(406);
    // Rewriting an accepted invite to rejected would leave the membership in
    // place while the record says it was declined.
    const reject = await call(
      u.url,
      wiggler,
      "POST",
      `/invite/${first.body.invite.id}/reject`,
    );
    expect(reject.status).toBe(406);

    const second = await invite(u.peach, { inviteeEmail: wiggler.email });
    await api.db.db
      .update(projectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectInvites.id, second.body.invite.id));
    const expired = await call(
      u.url,
      wiggler,
      "POST",
      `/invite/${second.body.invite.id}/accept`,
    );
    expect(expired.status).toBe(406);
  });

  test("rejecting joins nothing and leaves the row for the inviter to see", async () => {
    const goomba = await createUserAndLogin(
      u.url,
      "Goomba",
      "goomba@koopa.troop",
    );
    const sent = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: goomba.email,
    });
    const res = await call<{ invite: { status: string } }>(
      u.url,
      goomba,
      "POST",
      `/invite/${sent.body.invite.id}/reject`,
    );
    expect(res.body.invite.status).toBe("rejected");
    expect(await organizationsOf(goomba)).toEqual([goomba.organizationId]);

    const list = await call<ActionResponse<InviteList>>(
      u.url,
      u.peach,
      "GET",
      `/project/${u.projectId}/invites`,
    );
    expect(
      list.body.invites.find((i) => i.id === sent.body.invite.id)?.status,
    ).toBe("rejected");
  });

  test("tags deleted after the invite are skipped, not failed", async () => {
    const shyguy = await createUserAndLogin(
      u.url,
      "Shy Guy",
      "shyguy@koopa.troop",
    );
    const temp = await call<{ tag: { id: number } }>(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/tag`,
      { name: "temporary" },
    );
    const sent = await invite(u.peach, {
      projectId: u.projectId,
      inviteeEmail: shyguy.email,
      tagIds: [temp.body.tag.id, u.tagIds.viewers],
    });
    await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${temp.body.tag.id}`,
    );
    const res = await call(
      u.url,
      shyguy,
      "POST",
      `/invite/${sent.body.invite.id}/accept`,
    );
    expect(res.status).toBe(200);
    const view = await call<{ callerTags: { name: string }[] }>(
      u.url,
      shyguy,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(view.body.callerTags.map((t) => t.name)).toEqual(["viewers"]);
  });
});

describe("lists and the sweep", () => {
  test("invite:list is admin-only; organization:invite-list shows both kinds to owners", async () => {
    expect(
      (await call(u.url, u.mario, "GET", `/project/${u.projectId}/invites`))
        .status,
    ).toBe(403);
    const all = await call<ActionResponse<OrganizationInviteList>>(
      u.url,
      u.peach,
      "GET",
      `/organization/${u.organizationId}/invites`,
    );
    const kinds = new Set(all.body.invites.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(["organization", "project"]);
  });

  test("invites:sweep deletes only expired invites", async () => {
    const live = await invite(u.peach, { inviteeEmail: "lakitu@cloud.nine" });
    const old = await invite(u.peach, { inviteeEmail: "blooper@sea.side" });
    await api.db.db
      .update(projectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectInvites.id, old.body.invite.id));
    const result = await runAction<{ deleted: number }>("invites:sweep");
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const left = await api.db.db
      .select({ id: projectInvites.id })
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.organizationId, u.organizationId),
          eq(projectInvites.id, live.body.invite.id),
        ),
      );
    expect(left.length).toBe(1);
    const gone = await api.db.db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.id, old.body.invite.id));
    expect(gone).toEqual([]);
  });
});

describe("accepting while the organization changes", () => {
  test("racing a removal from the organization answers, never a 500", async () => {
    // The removal locks the organization row; accepting locks it (KEY SHARE)
    // before the invite, so one waits for the other and both answer.
    for (let round = 0; round < 8; round++) {
      const owner = await createUserAndLogin(
        u.url,
        "Cranky",
        `cranky${round}@kong.example`,
      );
      const guest = await createUserAndLogin(
        u.url,
        "Funky",
        `funky${round}@kong.example`,
      );
      const orgId = owner.organizationId;
      const first = await call<{ invite: { id: number } }>(
        u.url,
        owner,
        "PUT",
        `/organization/${orgId}/invite`,
        { inviteeEmail: guest.email },
      );
      await call(
        u.url,
        guest,
        "POST",
        `/invite/${first.body.invite.id}/accept`,
      );
      const second = await call<{ invite: { id: number } }>(
        u.url,
        owner,
        "PUT",
        `/organization/${orgId}/invite`,
        { projectId: owner.projectId, inviteeEmail: guest.email },
      );

      const [accept, remove] = await Promise.all([
        call(u.url, guest, "POST", `/invite/${second.body.invite.id}/accept`),
        call(
          u.url,
          owner,
          "DELETE",
          `/organization/${orgId}/member/${guest.userId}`,
        ),
      ]);
      expect([accept.status, remove.status], `round ${round}`).not.toContain(
        500,
      );
      expect(remove.status, `round ${round}`).toBe(200);
      // Whichever went first, the guest is out: the removal either took the new
      // membership with it or withdrew the invite before it was accepted.
      const view = await call(
        u.url,
        guest,
        "GET",
        `/project/${owner.projectId}`,
      );
      expect(view.status, `round ${round}`).toBe(403);
    }
  }, 60_000);

  test("racing the organization's deletion answers, never a 500 or a deadlock", async () => {
    for (let round = 0; round < 8; round++) {
      const owner = await createUserAndLogin(
        u.url,
        "Dixie",
        `dixie${round}@kong.example`,
      );
      const guest = await createUserAndLogin(
        u.url,
        "Kiddy",
        `kiddy${round}@kong.example`,
      );
      const created = await call<{ organization: { id: number } }>(
        u.url,
        owner,
        "PUT",
        "/organization",
        { name: `Empty ${round}` },
      );
      const orgId = created.body.organization.id;
      const sent = await call<{ invite: { id: number } }>(
        u.url,
        owner,
        "PUT",
        `/organization/${orgId}/invite`,
        { inviteeEmail: guest.email },
      );
      const [accept, remove] = await Promise.all([
        call(u.url, guest, "POST", `/invite/${sent.body.invite.id}/accept`),
        call(u.url, owner, "DELETE", `/organization/${orgId}`),
      ]);
      expect([accept.status, remove.status], `round ${round}`).not.toContain(
        500,
      );
    }
  }, 60_000);
});
