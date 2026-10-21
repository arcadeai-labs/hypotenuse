import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api } from "keryx";
import type { SerializedExternalIdentity } from "../../ops/IdentityOps";
import { auditLogs } from "../../schema/audit_logs";
import { FINEAR_FIXTURES, useFinear } from "../linear/finear";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `external-identity:*` over HTTP: an admin links a Linear user to a member,
 * the member (or an admin) unlinks it, everyone in the project reads the
 * list, and every change is audited.
 */

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
}, HOOK_TIMEOUT);

/** A JSON answer. */
interface Answer<T> {
  status: number;
  body: T & { error?: { message: string; key?: string } };
}

/**
 * Call an action over HTTP as someone.
 * @param method - The verb.
 * @param path - The route under `/api`.
 * @param user - Who.
 * @param body - The JSON body (or query, for GET).
 * @returns Status and body.
 */
async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  user: TestUser,
  body: Record<string, unknown> = {},
): Promise<Answer<T>> {
  const params = { projectId: universe.projectId, ...body };
  const res =
    method === "GET"
      ? await fetch(
          `${url}/api${path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`,
          { headers: cookieHeader(user.sessionId) },
        )
      : await fetch(`${url}/api${path}`, {
          method,
          headers: authHeaders(user.sessionId),
          body: JSON.stringify(params),
        });
  return { status: res.status, body: (await res.json()) as Answer<T>["body"] };
}

/**
 * Link a Linear user to a member, as Peach.
 * @param user - The member.
 * @param externalUserId - The Linear user.
 * @returns The identity.
 */
async function link(
  user: TestUser,
  externalUserId: string,
): Promise<SerializedExternalIdentity> {
  const { status, body } = await call<{
    externalIdentity: SerializedExternalIdentity;
  }>("PUT", "/external-identity", universe.peach, {
    userId: user.userId,
    externalUserId,
    externalName: `${user.name} in Linear`,
  });
  expect(status).toBe(200);
  return body.externalIdentity;
}

describe("external-identity:*", () => {
  test("an admin links a Linear user to a member; the link is audited", async () => {
    const identity = await link(universe.mario, FINEAR_FIXTURES.primary.user);
    expect(identity).toMatchObject({
      type: "linear",
      userId: universe.mario.userId,
      user: { name: "Mario", email: "mario@mushroom.kingdom" },
      externalUserId: FINEAR_FIXTURES.primary.user,
      externalName: "Mario in Linear",
      linkedVia: "admin",
    });
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "external-identity:link"),
          eq(auditLogs.projectId, universe.projectId),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit.targetPath).toBe(`linear:${FINEAR_FIXTURES.primary.user}`);
  });

  test("linking the same Linear user again moves the link, keeping one row", async () => {
    const moved = await link(universe.luigi, FINEAR_FIXTURES.primary.user);
    expect(moved.userId).toBe(universe.luigi.userId);
    const { body } = await call<{
      externalIdentities: SerializedExternalIdentity[];
      pagination: { total: number };
    }>("GET", "/external-identities", universe.toad);
    expect(body.externalIdentities.map((i) => i.userId)).toEqual([
      universe.luigi.userId,
    ]);
    expect(body.pagination.total).toBe(1);
  });

  test("only an admin links, only members are linked, and outsiders read nothing", async () => {
    for (const user of [universe.mario, universe.toad, universe.bowser]) {
      const res = await call("PUT", "/external-identity", user, {
        userId: user.userId,
        externalUserId: "someone-else",
      });
      expect(res.status, user.name).toBe(403);
    }
    const stranger = await call("PUT", "/external-identity", universe.peach, {
      userId: universe.bowser.userId,
      externalUserId: "bowser-in-linear",
    });
    expect(stranger.status).toBe(406);
    expect(stranger.body.error?.key).toBe("userId");
    expect(
      (await call("GET", "/external-identities", universe.bowser)).status,
    ).toBe(403);
  });

  test("a member removes their own link but not another's; an admin removes anyone's", async () => {
    const toads = await link(universe.toad, "toad-in-linear");
    const luigis = (
      await call<{ externalIdentities: SerializedExternalIdentity[] }>(
        "GET",
        "/external-identities",
        universe.luigi,
        { userId: universe.luigi.userId },
      )
    ).body.externalIdentities[0];

    expect(
      (await call("DELETE", `/external-identity/${luigis.id}`, universe.toad))
        .status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/external-identity/${toads.id}`, universe.toad))
        .status,
    ).toBe(200);
    expect(
      (await call("DELETE", `/external-identity/${luigis.id}`, universe.peach))
        .status,
    ).toBe(200);
    expect(
      (await call("DELETE", `/external-identity/${luigis.id}`, universe.peach))
        .status,
    ).toBe(404);
    const elsewhere = await call(
      "DELETE",
      `/external-identity/${toads.id}`,
      universe.bowser,
      { projectId: universe.bowser.projectId },
    );
    expect(elsewhere.status).toBe(404);
    const { body } = await call<{
      externalIdentities: SerializedExternalIdentity[];
    }>("GET", "/external-identities", universe.peach);
    expect(body.externalIdentities).toEqual([]);
  });

  test("a project with no Linear connection lists none and links none", async () => {
    const own = await call<{
      externalIdentities: SerializedExternalIdentity[];
      pagination: { total: number };
    }>("GET", "/external-identities", universe.bowser, {
      projectId: universe.bowser.projectId,
    });
    expect(own.status).toBe(200);
    expect(own.body.externalIdentities).toEqual([]);
    const refused = await call("PUT", "/external-identity", universe.bowser, {
      projectId: universe.bowser.projectId,
      userId: universe.bowser.userId,
      externalUserId: "x",
    });
    expect(refused.status).toBe(406);
    expect(refused.body.error?.key).toBe("type");
  });
});
