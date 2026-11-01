import { asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import { githubInstallations } from "../../schema/github_installations";
import { repositoryGrants } from "../../schema/repository_grants";

/**
 * `repository-grant:list` — the repositories a project's bots are granted,
 * by name. Requires membership. Paginated.
 */
export class RepositoryGrantList implements Action {
  name = "repository-grant:list";
  description =
    "List the project's repository grants by repository name: each repository, the installation it is reached through, whether bots may push, its branch prefix, and which bots may use it. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/repository-grants",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose grants to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns `{ repositoryGrants, pagination }`.
   */
  async run(params: ActionParams<RepositoryGrantList>) {
    const where = eq(repositoryGrants.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select({ grant: repositoryGrants, installation: githubInstallations })
        .from(repositoryGrants)
        .innerJoin(
          githubInstallations,
          eq(githubInstallations.id, repositoryGrants.githubInstallationId),
        )
        .where(where)
        .orderBy(asc(repositoryGrants.owner), asc(repositoryGrants.name))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(repositoryGrants).where(where),
      params,
    );
    return {
      repositoryGrants: result.data.map((r) =>
        serializeRepositoryGrant(r.grant, r.installation),
      ),
      pagination: result.pagination,
    };
  }
}
