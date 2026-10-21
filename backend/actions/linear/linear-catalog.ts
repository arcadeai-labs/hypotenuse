import {
  type Action,
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadCatalog } from "../../ops/LinearCatalogOps";
import {
  getInstallationForProject,
  linearErrorToTypedError,
} from "../../ops/LinearOps";

/**
 * `linear:catalog` — the connected workspace's teams (with workflow states),
 * projects, and labels, for the routing-rule editor, runner subscriptions, and
 * the CLI's prompts. Read server-side and cached briefly per installation, so no
 * client holds a Linear token to fill a dropdown.
 */
export class LinearCatalogView implements Action {
  name = "linear:catalog";
  description =
    "List the connected Linear workspace's teams (with their workflow states), projects, and labels, as the @hypotenuse app user sees them. Cached for about a minute.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/linear/catalog", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose Linear workspace to read"),
  });

  /**
   * @param params - The project.
   * @returns `{ teams, projects, labels }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when no workspace is
   *   connected; 429 when Linear's rate limit is exhausted.
   */
  async run(params: ActionParams<LinearCatalogView>) {
    const installation = await getInstallationForProject(params.projectId);
    if (!installation || installation.status !== "active") {
      throw new TypedError({
        message: "This project has no working Linear connection",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    try {
      return await loadCatalog(installation);
    } catch (e) {
      throw linearErrorToTypedError(e);
    }
  }
}
