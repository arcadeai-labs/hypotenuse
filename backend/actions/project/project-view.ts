import { eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  config,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { idInput } from "../../ops/InputOps";
import { isAdmin, projectStanding } from "../../ops/MembershipOps";
import { serializeOrganization } from "../../ops/OrganizationOps";
import { serializeProject } from "../../ops/ProjectOps";
import { serializeTag } from "../../ops/TagOps";
import { organizations } from "../../schema/organizations";

/**
 * `project:view` — one project, the caller's tags in it, and their `standing`.
 *
 * Standing is a server answer: "am I an admin here, and is that because I own
 * the organization" is decided by the same code the RBAC middleware runs, so a
 * client never has to know the rule is spelled `admin`, or that owners have it.
 *
 * `mcp` is the same bargain applied to an address: the endpoint an external MCP
 * client connects to is server configuration the frontend cannot see.
 */
export class ProjectView implements Action {
  name = "project:view";
  description =
    "Get one project, its organization, the tags you hold in it, and your standing (member, admin, and whether admin standing comes from owning the organization). Requires member standing in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: idInput("The project to view"),
  });

  /**
   * @param _params - The validated inputs, consumed by the middleware.
   * @param connection - The caller's connection (project and tags set by middleware).
   * @returns The project, its organization, the caller's tags and standing, and
   *   where an external MCP client connects.
   */
  async run(
    _params: ActionParams<ProjectView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const project = connection.metadata.project!;
    const callerTags = connection.metadata.callerTags ?? [];
    const [organization] = await api.db.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);

    return {
      project: serializeProject(project),
      organization: serializeOrganization(organization),
      // An owner's synthetic `admin` row is standing, not a grant they hold.
      callerTags: (connection.metadata.viaOrganizationOwner
        ? callerTags.filter((t) => !isAdmin([t]))
        : callerTags
      ).map(serializeTag),
      standing: projectStanding({
        callerTags,
        viaOrganizationOwner: connection.metadata.viaOrganizationOwner ?? false,
      }),
      mcp: {
        enabled: config.server.mcp.enabled,
        // Trailing slashes on either half would produce `//mcp`, and a 404 on a
        // URL somebody copied out of the UI is the least debuggable kind.
        url: `${config.server.web.applicationUrl.replace(/\/+$/, "")}${config.server.mcp.route}`,
      },
    };
  }
}
