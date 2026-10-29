import { and, asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { type SessionImpl, SessionMiddleware } from "../../middleware/session";
import { idInput } from "../../ops/InputOps";
import { projectStandings } from "../../ops/MembershipOps";
import {
  serializeProject,
  visibleProjectsCondition,
} from "../../ops/ProjectOps";
import { projects } from "../../schema/projects";

/**
 * `project:list` — the projects the caller can see, by name: those they hold a
 * membership in, plus every project of an organization they own. Membership in
 * an organization alone shows nothing. Backs the project switcher and
 * Organization → Projects, so each project carries the caller's `standing` in
 * it, the same answer `project:view` gives.
 */
export class ProjectList implements Action {
  name = "project:list";
  description =
    "List the projects you can see — those you are a member of, plus every project in organizations you own — ordered by name, optionally within one organization, each with your standing in it (admin, and whether that comes from owning the organization). Requires an active session. Paginated.";
  middleware = [SessionMiddleware];
  web = { route: "/projects", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    organizationId: idInput("Only projects in this organization").optional(),
  });

  /**
   * @param params - An optional organization filter plus pagination inputs.
   * @param connection - The caller's connection.
   * @returns The projects plus pagination metadata.
   */
  async run(
    params: ActionParams<ProjectList>,
    connection: Connection<SessionImpl>,
  ) {
    const userId = connection.session!.data.userId!;
    const where = and(
      visibleProjectsCondition(api.db.db, userId),
      params.organizationId
        ? eq(projects.organizationId, params.organizationId)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(projects)
        .where(where)
        .orderBy(asc(projects.name), asc(projects.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(projects).where(where),
      params,
    );
    const standings = await projectStandings(userId, result.data);
    return {
      projects: result.data.map((project) => ({
        ...serializeProject(project),
        standing: standings.get(project.id)!,
      })),
      pagination: result.pagination,
    };
  }
}
