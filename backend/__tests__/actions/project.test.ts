import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { ProjectCreate } from "../../actions/project/project-create";
import type { ProjectView } from "../../actions/project/project-view";
import { auditLogs } from "../../schema/audit_logs";
import { projectMemberships } from "../../schema/project_memberships";
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

describe("project:create", () => {
  test("only an owner creates a project, and becomes its explicit admin", async () => {
    const member = await call(u.url, u.daisy, "PUT", "/project", {
      organizationId: u.organizationId,
      name: "Garden",
    });
    expect(member.status).toBe(403);

    const created = await call<ActionResponse<ProjectCreate>>(
      u.url,
      u.peach,
      "PUT",
      "/project",
      {
        organizationId: u.organizationId,
        name: "Castle",
      },
    );
    expect(created.status).toBe(200);
    // A second "Castle" in the same organization gets its own slug.
    expect(created.body.project.slug).toBe("castle-2");

    const view = await call<ActionResponse<ProjectView>>(
      u.url,
      u.peach,
      "GET",
      `/project/${created.body.project.id}`,
    );
    expect(view.body.standing).toEqual({
      isMember: true,
      isAdmin: true,
      viaOrganizationOwner: false,
    });

    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, created.body.project.id));
    expect(row.action).toBe("project:create");
  });

  test("an owner of another organization cannot create one here", async () => {
    const res = await call(u.url, u.bowser, "PUT", "/project", {
      organizationId: u.organizationId,
      name: "Airship",
    });
    expect(res.status).toBe(403);
  });
});

describe("project:view and project:settings-view", () => {
  test("answer the project, its organization, and where MCP clients connect", async () => {
    const { body } = await call<ActionResponse<ProjectView>>(
      u.url,
      u.mario,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(body.project).toMatchObject({
      name: "Castle",
      organizationId: u.organizationId,
    });
    expect(body.organization.name).toBe("Mushroom Kingdom");
    expect(body.mcp.url).toMatch(/\/mcp$/);
    expect(body.mcp.url).not.toContain("//mcp");

    const settings = await call<{ settings: { projectId: number } }>(
      u.url,
      u.mario,
      "GET",
      `/project/${u.projectId}/settings`,
    );
    expect(settings.body.settings.projectId).toBe(u.projectId);
  });
});

describe("project:list", () => {
  test("pages through the visible projects by name", async () => {
    const { body } = await call<{
      projects: { name: string }[];
      pagination: { total: number; pages: number };
    }>(
      u.url,
      u.peach,
      "GET",
      `/projects?organizationId=${u.organizationId}&limit=2`,
    );
    expect(body.projects.map((p) => p.name)).toEqual(["Castle", "Castle"]);
    expect(body.pagination).toMatchObject({ total: 3, pages: 2 });
  });
});

describe("project:edit and project:delete", () => {
  test("a member cannot rename; an admin can, and the slug follows", async () => {
    const refused = await call(
      u.url,
      u.mario,
      "POST",
      `/project/${u.projectId}`,
      {
        name: "Bowser's Castle",
      },
    );
    expect(refused.status).toBe(403);
    const renamed = await call<{ project: { slug: string } }>(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}`,
      { name: "Peach's Castle" },
    );
    expect(renamed.body.project.slug).toBe("peach-s-castle");
  });

  test("deleting cascades to memberships, and the audit log outlives it", async () => {
    const res = await call(u.url, u.peach, "DELETE", `/project/${u.projectId}`);
    expect(res.status).toBe(200);
    const left = await api.db.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, u.projectId));
    expect(left).toEqual([]);
    const history = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, u.projectId));
    expect(history.map((r) => r.action)).toContain("project:delete");
    expect(
      (await call(u.url, u.mario, "GET", `/project/${u.projectId}`)).status,
    ).toBe(403);
  });
});
