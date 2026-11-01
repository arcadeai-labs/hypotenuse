import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { grantWarnings, loadGrant } from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";

/**
 * `repository-grant:view` — one repository grant: the repository, whether it
 * may push, its branch prefix and the ruleset that would enforce it, the bots
 * it covers, and any warning. Requires membership.
 */
export class RepositoryGrantView implements Action {
  name = "repository-grant:view";
  description =
    "Get one repository grant: the repository, whether bots may push, its branch prefix and the recommended GitHub ruleset for it, which bots may use it, and any warning. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/repository-grant/:grantId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    grantId: idInput("The grant"),
  });

  /**
   * @param params - `projectId` and `grantId`.
   * @returns `{ repositoryGrant, warnings }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(params: ActionParams<RepositoryGrantView>) {
    const { grant, installation } = await loadGrant(
      api.db.db,
      params.projectId,
      params.grantId,
    );
    return {
      repositoryGrant: serializeRepositoryGrant(grant, installation),
      warnings: grantWarnings(grant),
    };
  }
}
