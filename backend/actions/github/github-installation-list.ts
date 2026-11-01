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
import { serializeGithubInstallation } from "../../ops/RepositoryOps";
import { githubInstallations } from "../../schema/github_installations";

/**
 * `github:installation-list` — the GitHub App installations attached to a
 * project, oldest first, each with its account, its permissions as GitHub
 * last reported them, and its status (`active`, `suspended`, `removed`).
 * Requires membership. Paginated.
 */
export class GithubInstallationList implements Action {
  name = "github:installation-list";
  description =
    "List the GitHub App installations attached to a project: the GitHub account each is on, its permissions, and whether it is active, suspended, or removed on GitHub. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/github/installations",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose installations to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns `{ installations, pagination }`.
   */
  async run(params: ActionParams<GithubInstallationList>) {
    const where = eq(githubInstallations.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(githubInstallations)
        .where(where)
        .orderBy(asc(githubInstallations.id))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(githubInstallations)
        .where(where),
      params,
    );
    return {
      installations: result.data.map(serializeGithubInstallation),
      pagination: result.pagination,
    };
  }
}
