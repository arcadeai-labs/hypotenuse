import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { AuditList } from "../../actions/audit/audit-list";
import type { OrganizationAuditList } from "../../actions/audit/organization-audit-list";
import type { ProjectCreate } from "../../actions/project/project-create";
import { auditLogs } from "../../schema/audit_logs";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

type Rows = ActionResponse<AuditList>;
type OrgRows = ActionResponse<OrganizationAuditList>;

let u: TestUniverse;
/** A project created and deleted in the Mushroom Kingdom. */
let moatId: number;

/**
 * Read a project's audit log.
 * @param who - The caller.
 * @param projectId - The project.
 * @param query - Filters and pagination, as a query string.
 * @returns The status and body.
 */
function projectLog(who: TestUser, projectId: number, query = "") {
  return call<Rows>(
    u.url,
    who,
    "GET",
    `/project/${projectId}/audit${query ? `?${query}` : ""}`,
  );
}

/**
 * Read an organization's audit log.
 * @param who - The caller.
 * @param organizationId - The organization.
 * @param query - Filters and pagination, as a query string.
 * @returns The status and body.
 */
function organizationLog(who: TestUser, organizationId: number, query = "") {
  return call<OrgRows>(
    u.url,
    who,
    "GET",
    `/organization/${organizationId}/audit${query ? `?${query}` : ""}`,
  );
}

beforeAll(async () => {
  u = await buildTestUniverse();
  const moat = await call<ActionResponse<ProjectCreate>>(
    u.url,
    u.peach,
    "PUT",
    "/project",
    { organizationId: u.organizationId, name: "Moat" },
  );
  moatId = moat.body.project.id;
  const deleted = await call(u.url, u.peach, "DELETE", `/project/${moatId}`, {
    confirmName: "Moat",
  });
  if (deleted.status !== 200) {
    throw new Error(`project:delete: ${JSON.stringify(deleted.body)}`);
  }
  // Daisy owns the Mushroom Kingdom from here on, without joining a project.
  await call(
    u.url,
    u.peach,
    "POST",
    `/organization/${u.organizationId}/member/${u.daisy.userId}`,
    { role: "owner" },
  );
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("audit:list", () => {
  test("a project admin reads that project's rows, newest first, with actors named", async () => {
    const { status, body } = await projectLog(u.peach, u.projectId);
    expect(status).toBe(200);
    expect(body.auditLogs.length).toBeGreaterThan(0);
    for (const row of body.auditLogs) {
      expect(row.projectId).toBe(u.projectId);
      expect(row.organizationId).toBe(u.organizationId);
      expect(row.projectName).toBe("Castle");
    }
    const created = body.auditLogs.map((r) => r.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
    const tagRow = body.auditLogs.find(
      (r) => r.action === "tag:create" && r.targetPath === "operators",
    )!;
    expect(tagRow.actor).toEqual({
      type: "user",
      userId: u.peach.userId,
      participantId: null,
      name: "Peach",
      email: "peach@mushroom.kingdom",
    });
    // The organization's own rows are not one project's.
    expect(body.auditLogs.some((r) => r.action === "organization:edit")).toBe(
      false,
    );
  });

  test("a member without admin standing is refused", async () => {
    expect((await projectLog(u.mario, u.projectId)).status).toBe(403);
  });

  test("an admin of one project cannot read another organization's project", async () => {
    expect((await projectLog(u.peach, u.bowser.projectId)).status).toBe(403);
  });

  test("an organization owner reads it through admin standing, without joining", async () => {
    const { status, body } = await projectLog(u.daisy, u.projectId);
    expect(status).toBe(200);
    expect(body.auditLogs.length).toBeGreaterThan(0);
  });

  test("filters by action, actor type, and target type", async () => {
    const byAction = await projectLog(
      u.peach,
      u.projectId,
      "action=tag:create",
    );
    expect(byAction.body.auditLogs.map((r) => r.targetPath).sort()).toEqual([
      "operators",
      "viewers",
    ]);
    const byTarget = await projectLog(u.peach, u.projectId, "targetType=tag");
    expect(byTarget.body.auditLogs.every((r) => r.targetType === "tag")).toBe(
      true,
    );
    const bySystem = await projectLog(u.peach, u.projectId, "actorType=system");
    expect(bySystem.body.auditLogs).toEqual([]);
    const badActor = await projectLog(u.peach, u.projectId, "actorType=robot");
    expect(badActor.status).toBe(406);
    expect(badActor.body.error?.key).toBe("actorType");
  });

  test("time ranges take epoch milliseconds and ISO 8601, inclusive", async () => {
    const all = (await projectLog(u.peach, u.projectId, "limit=100")).body
      .auditLogs;
    const pivot = all[Math.floor(all.length / 2)];

    const since = await projectLog(
      u.peach,
      u.projectId,
      `limit=100&since=${pivot.createdAt}`,
    );
    expect(since.status).toBe(200);
    expect(since.body.auditLogs.map((r) => r.id)).toEqual(
      all.filter((r) => r.createdAt >= pivot.createdAt).map((r) => r.id),
    );

    const until = await projectLog(
      u.peach,
      u.projectId,
      `limit=100&until=${encodeURIComponent(new Date(pivot.createdAt).toISOString())}`,
    );
    expect(until.body.auditLogs.map((r) => r.id)).toEqual(
      all.filter((r) => r.createdAt <= pivot.createdAt).map((r) => r.id),
    );

    const future = await projectLog(
      u.peach,
      u.projectId,
      `since=${Date.now() + 60_000}`,
    );
    expect(future.body.auditLogs).toEqual([]);
    expect(future.body.pagination.total).toBe(0);

    const nonsense = await projectLog(u.peach, u.projectId, "since=last-week");
    expect(nonsense.status).toBe(406);
    expect(nonsense.body.error?.key).toBe("since");
  });

  test("paginates, and pages do not overlap", async () => {
    const all = (await projectLog(u.peach, u.projectId, "limit=100")).body;
    expect(all.pagination.total).toBeGreaterThanOrEqual(4);
    const first = (await projectLog(u.peach, u.projectId, "limit=2&page=1"))
      .body;
    const second = (await projectLog(u.peach, u.projectId, "limit=2&page=2"))
      .body;
    expect(first.pagination).toEqual({
      page: 1,
      limit: 2,
      total: all.pagination.total,
      pages: Math.ceil(all.pagination.total / 2),
    });
    expect(first.auditLogs.map((r) => r.id)).toEqual(
      all.auditLogs.slice(0, 2).map((r) => r.id),
    );
    expect(second.auditLogs.map((r) => r.id)).toEqual(
      all.auditLogs.slice(2, 4).map((r) => r.id),
    );
  });
});

describe("organization:audit-list", () => {
  test("an owner reads the organization's rows and every project's in it", async () => {
    const { status, body } = await organizationLog(
      u.peach,
      u.organizationId,
      "limit=100",
    );
    expect(status).toBe(200);
    for (const row of body.auditLogs) {
      expect(row.organizationId).toBe(u.organizationId);
    }
    const projects = new Set(body.auditLogs.map((r) => r.projectId));
    expect(projects.has(u.projectId)).toBe(true);
    expect(projects.has(u.peach.projectId)).toBe(true);
    expect(projects.has(null)).toBe(true);
    expect(body.auditLogs.some((r) => r.action === "organization:edit")).toBe(
      true,
    );
    // Nothing of Koopa Troop's.
    expect(projects.has(u.bowser.projectId)).toBe(false);
  });

  test("an owner who never joined a project reads it too", async () => {
    const { status, body } = await organizationLog(
      u.daisy,
      u.organizationId,
      `projectId=${u.projectId}`,
    );
    expect(status).toBe(200);
    expect(body.auditLogs.every((r) => r.projectId === u.projectId)).toBe(true);
  });

  test("members who do not own it, and outsiders, are refused", async () => {
    expect((await organizationLog(u.mario, u.organizationId)).status).toBe(403);
    expect((await organizationLog(u.bowser, u.organizationId)).status).toBe(
      403,
    );
    expect((await organizationLog(u.peach, u.koopaOrganizationId)).status).toBe(
      403,
    );
  });

  test("a deleted project's history outlives it", async () => {
    const { body } = await organizationLog(
      u.peach,
      u.organizationId,
      `projectId=${moatId}`,
    );
    expect(body.auditLogs.map((r) => r.action)).toEqual([
      "project:delete",
      "project:create",
    ]);
    expect(body.auditLogs.every((r) => r.projectName === null)).toBe(true);
  });

  test("a project of another organization filters to nothing rather than leaking", async () => {
    const { status, body } = await organizationLog(
      u.peach,
      u.organizationId,
      `projectId=${u.bowser.projectId}`,
    );
    expect(status).toBe(200);
    expect(body.auditLogs).toEqual([]);
  });

  test("the sign-up bootstrap's rows are the system's", async () => {
    const { body } = await organizationLog(
      u.peach,
      u.organizationId,
      "actorType=system",
    );
    expect(body.auditLogs.map((r) => r.action).sort()).toEqual([
      "organization:create",
      "project:create",
    ]);
    for (const row of body.auditLogs) {
      expect(row.actor).toEqual({
        type: "system",
        userId: null,
        participantId: null,
        name: null,
        email: null,
      });
    }
  });
});

describe("audit:sweep", () => {
  test("deletes rows past the retention window and keeps the rest", async () => {
    const day = 24 * 60 * 60 * 1000;
    const [old] = await api.db.db
      .insert(auditLogs)
      .values({
        actorType: "system",
        action: "test:ancient",
        createdAt: new Date(Date.now() - 400 * day),
      })
      .returning();
    const [recent] = await api.db.db
      .insert(auditLogs)
      .values({
        actorType: "system",
        action: "test:recent",
        createdAt: new Date(Date.now() - 300 * day),
      })
      .returning();

    const result = await runAction<{ deleted: number }>("audit:sweep");
    expect(result.deleted).toBe(1);
    const remaining = await api.db.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, old.id));
    expect(remaining).toEqual([]);
    const kept = await api.db.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, recent.id));
    expect(kept).toHaveLength(1);
  });
});
