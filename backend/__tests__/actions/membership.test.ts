import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { MembershipList } from "../../actions/membership/membership-list";
import type { ProjectCreate } from "../../actions/project/project-create";
import type { TagList } from "../../actions/tag/tag-list";
import { getAdminUserIds } from "../../ops/MembershipOps";
import { runnerSessionsKey } from "../../ops/RunnerOps";
import { ADMIN_TAG } from "../../ops/TagOps";
import {
  connect,
  eventually,
  frames,
  heartbeat,
  heartbeatBody,
  openSocket,
  registerRunner,
  runnerRow,
  sessionCookie,
  subscribe,
} from "../runners/helpers";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  createUserAndLogin,
  HOOK_TIMEOUT,
  inviteAndAccept,
  TEST_PASSWORD,
  type TestUniverse,
} from "../setup";

let universe: TestUniverse;
let url: string;
let adminTagId: number;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;

  const res = await fetch(
    `${url}/api/tags?projectId=${universe.projectId}&limit=100`,
    { headers: cookieHeader(universe.peach.sessionId) },
  );
  const body = (await res.json()) as ActionResponse<TagList>;
  adminTagId = body.tags.find((t) => t.name === ADMIN_TAG)!.id;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * List the shared project's members as Peach (its admin).
 * @returns The membership rows, each with their user and tags.
 */
async function listMembers(): Promise<
  ActionResponse<MembershipList>["memberships"]
> {
  const res = await fetch(
    `${url}/api/memberships?projectId=${universe.projectId}&limit=100`,
    { headers: cookieHeader(universe.peach.sessionId) },
  );
  const body = (await res.json()) as ActionResponse<MembershipList>;
  return body.memberships;
}

describe("membership:list", () => {
  test("returns every member with their profile and project tags", async () => {
    const members = await listMembers();
    expect(members.length).toBe(4); // Peach, Mario, Luigi, Toad

    const peach = members.find((m) => m.userId === universe.peach.userId);
    expect(peach?.user.email).toBe(universe.peach.email);
    expect(peach?.tags.map((t) => t.name)).toContain(ADMIN_TAG);

    const mario = members.find((m) => m.userId === universe.mario.userId);
    expect(mario?.tags.map((t) => t.name)).toEqual(["operators"]);

    // Toad joined with no tags — a member with an empty tag list is valid.
    const toad = members.find((m) => m.userId === universe.toad.userId);
    expect(toad?.tags).toEqual([]);
  });

  test("honors limit and page with correct totals", async () => {
    const res = await fetch(
      `${url}/api/memberships?projectId=${universe.projectId}&limit=2&page=2`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    const body = (await res.json()) as ActionResponse<MembershipList>;
    expect(body.memberships.length).toBe(2);
    expect(body.pagination.total).toBe(4);
    expect(body.pagination.pages).toBe(2);
    expect(body.pagination.page).toBe(2);
  });

  test("is readable by a plain member, not by an outsider", async () => {
    const member = await fetch(
      `${url}/api/memberships?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.toad.sessionId) },
    );
    expect(member.status).toBe(200);

    const outsider = await fetch(
      `${url}/api/memberships?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.bowser.sessionId) },
    );
    expect(outsider.status).toBe(403);
  });
});

describe("membership:create", () => {
  test("an admin adds an existing user by email", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        email: universe.bowser.email.toUpperCase(),
      }),
    });
    expect(res.status).toBe(200);

    const members = await listMembers();
    expect(members.map((m) => m.userId)).toContain(universe.bowser.userId);
  });

  test("adding the same user twice is refused", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        email: universe.bowser.email,
      }),
    });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("already a member");
  });

  test("an unknown email is a validation error naming the field", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        email: "nobody@mushroom.kingdom",
      }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error?: { key?: string } };
    expect(body.error?.key).toBe("email");
  });

  test("a plain member cannot add anyone", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "PUT",
      headers: authHeaders(universe.toad.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        email: universe.bowser.email,
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe("membership:delete", () => {
  test("removing a member also revokes their tags in that project", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.mario.userId,
      }),
    });
    expect(res.status).toBe(200);

    const members = await listMembers();
    expect(members.map((m) => m.userId)).not.toContain(universe.mario.userId);

    // He keeps his own project — only this project's tags were revoked.
    const own = await fetch(
      `${url}/api/project?projectId=${universe.mario.projectId}`,
      { headers: cookieHeader(universe.mario.sessionId) },
    );
    expect(own.status).toBe(200);

    // And the shared project is now closed to him.
    const shared = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.mario.sessionId) },
    );
    expect(shared.status).toBe(403);
  });

  test("removing a member revokes the runners they registered in that project, and only those", async () => {
    const yoshi = await createUserAndLogin(
      url,
      "Yoshi",
      "yoshi@yoshis.island",
      TEST_PASSWORD,
    );
    await inviteAndAccept(url, universe.peach, universe.projectId, yoshi, []);
    const shared = await registerRunner(
      url,
      yoshi,
      universe.projectId,
      "yoshi-shared",
    );
    const own = await registerRunner(url, yoshi, yoshi.projectId, "yoshi-own");

    const connected = await connect(
      url,
      shared.token,
      heartbeatBody().machineId,
    );
    const session = sessionCookie(connected);
    const socket = await openSocket(url, session);
    try {
      expect((await subscribe(socket, `runner:${shared.id}`)).ok).toBe(true);

      const res = await fetch(`${url}/api/membership`, {
        method: "DELETE",
        headers: authHeaders(universe.peach.sessionId),
        body: JSON.stringify({
          projectId: universe.projectId,
          userId: yoshi.userId,
        }),
      });
      expect(res.status).toBe(200);

      const revoked = await runnerRow(shared.id);
      expect(revoked.status).toBe("revoked");
      expect(revoked.revokedReason).toBe("membership_removed");
      expect((await runnerRow(own.id)).status).not.toBe("revoked");

      expect(
        await eventually(() =>
          frames(socket, `runner:${shared.id}`).includes("revoked"),
        ),
      ).toBe(true);
      expect(await api.redis.redis.exists(runnerSessionsKey(shared.id))).toBe(
        0,
      );
      expect((await heartbeat(url, shared.token, heartbeatBody())).status).toBe(
        401,
      );
      expect((await heartbeat(url, own.token, heartbeatBody())).status).toBe(
        200,
      );
    } finally {
      socket.socket.close();
    }
  });

  test("removing a non-member is a validation error", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.mario.userId,
      }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error?: { key?: string } };
    expect(body.error?.key).toBe("userId");
  });

  test("the last admin cannot be removed", async () => {
    const res = await fetch(`${url}/api/membership`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.peach.userId,
      }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("last admin");

    // She is still there, still administering.
    const members = await listMembers();
    expect(members.map((m) => m.userId)).toContain(universe.peach.userId);
  });

  test("a second admin makes the first removable", async () => {
    await fetch(`${url}/api/user-tag`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.luigi.userId,
        tagId: adminTagId,
      }),
    });

    const res = await fetch(`${url}/api/membership`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.peach.userId,
      }),
    });
    expect(res.status).toBe(200);

    // Luigi now administers the project Peach created.
    const list = await fetch(
      `${url}/api/memberships?projectId=${universe.projectId}&limit=100`,
      { headers: cookieHeader(universe.luigi.sessionId) },
    );
    const body = (await list.json()) as ActionResponse<MembershipList>;
    expect(body.memberships.map((m) => m.userId)).not.toContain(
      universe.peach.userId,
    );
  });
});

describe("user-tag:remove and the last admin", () => {
  test("the admin tag cannot be revoked from the last admin", async () => {
    // Luigi is now the shared project's only admin (previous suite).
    const res = await fetch(`${url}/api/user-tag`, {
      method: "DELETE",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.luigi.userId,
        tagId: adminTagId,
      }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("last admin");
  });

  test("a non-admin tag can still be revoked freely", async () => {
    const res = await fetch(`${url}/api/user-tag`, {
      method: "DELETE",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.luigi.userId,
        tagId: universe.tagIds.viewers,
      }),
    });
    expect(res.status).toBe(200);
  });

  test("assigning a tag to a non-member is refused", async () => {
    const res = await fetch(`${url}/api/user-tag`, {
      method: "PUT",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.mario.userId, // removed from this project earlier
        tagId: universe.tagIds.operators,
      }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error?: { key?: string } };
    expect(body.error?.key).toBe("userId");
  });

  test("assigning an already-held tag is idempotent", async () => {
    const first = await fetch(`${url}/api/user-tag`, {
      method: "PUT",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.toad.userId,
        tagId: universe.tagIds.operators,
      }),
    });
    const second = await fetch(`${url}/api/user-tag`, {
      method: "PUT",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.toad.userId,
        tagId: universe.tagIds.operators,
      }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as { userTag: { id: number } };
    const secondBody = (await second.json()) as { userTag: { id: number } };
    expect(secondBody.userTag.id).toBe(firstBody.userTag.id);
  });
});

describe("the last-admin guard under concurrency", () => {
  /**
   * A fresh project Peach administers with Mario as a second admin, so the
   * shared universe is untouched.
   * @returns The project id and its admin tag id.
   */
  async function twoAdminProject(
    name: string,
  ): Promise<{ projectId: number; adminTag: number }> {
    const created = await fetch(`${url}/api/project`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ name }),
    });
    const { project } = (await created.json()) as ActionResponse<ProjectCreate>;
    await inviteAndAccept(url, universe.peach, project.id, universe.mario, []);

    const tagsRes = await fetch(
      `${url}/api/tags?projectId=${project.id}&limit=100`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    const tagsBody = (await tagsRes.json()) as ActionResponse<TagList>;
    const adminTag = tagsBody.tags.find((t) => t.name === ADMIN_TAG)!.id;

    const grant = await fetch(`${url}/api/user-tag`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: project.id,
        userId: universe.mario.userId,
        tagId: adminTag,
      }),
    });
    expect(grant.status).toBe(200);
    return { projectId: project.id, adminTag };
  }

  test("two admins removing each other at once leave one admin", async () => {
    const { projectId } = await twoAdminProject("Mutual Removal");

    const [peachRemovesMario, marioRemovesPeach] = await Promise.all([
      fetch(`${url}/api/membership`, {
        method: "DELETE",
        headers: authHeaders(universe.peach.sessionId),
        body: JSON.stringify({ projectId, userId: universe.mario.userId }),
      }),
      fetch(`${url}/api/membership`, {
        method: "DELETE",
        headers: authHeaders(universe.mario.sessionId),
        body: JSON.stringify({ projectId, userId: universe.peach.userId }),
      }),
    ]);

    // The project row lock serializes the two guards: exactly one wins.
    expect([peachRemovesMario.status, marioRemovesPeach.status].sort()).toEqual(
      [200, 406],
    );
    expect(await getAdminUserIds(api.db.db, projectId)).toHaveLength(1);
  });

  test("two admins revoking each other's admin tag at once leave one admin", async () => {
    const { projectId, adminTag } = await twoAdminProject("Mutual Revoke");

    const revoke = (actor: string, userId: number) =>
      fetch(`${url}/api/user-tag`, {
        method: "DELETE",
        headers: authHeaders(actor),
        body: JSON.stringify({ projectId, userId, tagId: adminTag }),
      });
    const results = await Promise.all([
      revoke(universe.peach.sessionId, universe.mario.userId),
      revoke(universe.mario.sessionId, universe.peach.userId),
    ]);

    // The loser is either refused by the guard (406) or, having lost its own
    // admin tag first, by the admin middleware (403). Either way one admin
    // remains.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await getAdminUserIds(api.db.db, projectId)).toHaveLength(1);
  });
});
