import {
  type Action,
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { getIntegration } from "../../ops/IntegrationOps";
import { loadCatalog } from "../../ops/LinearCatalogOps";
import { linearErrorToTypedError } from "../../ops/LinearOps";
import { TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `integration:catalog` — the connected workspace's teams (with workflow
 * states), projects, and labels, as the app user sees them: what routing rules
 * and runner subscriptions are written against, read on the server so no
 * client holds a token to fill a dropdown. Cached briefly per integration.
 * Requires membership.
 */
export class IntegrationCatalog implements Action {
  name = "integration:catalog";
  description =
    "List the connected workspace's teams (with their workflow states), projects, and labels in one trigger system (today: linear), as the @hypotenuse app user sees them. Cached for about a minute.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/integration/catalog", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose connected workspace to read"),
    type: z.enum(TRIGGER_TYPES).describe("The trigger system, e.g. linear"),
  });

  /**
   * @param params - The project and type.
   * @returns `{ teams, projects, labels }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when no workspace of
   *   that type is connected; 429 when its rate limit is exhausted.
   */
  async run(params: ActionParams<IntegrationCatalog>) {
    const integration = await getIntegration(params.projectId, params.type);
    if (!integration || integration.status !== "active") {
      throw new TypedError({
        message: `This project has no working ${params.type} integration`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    try {
      return await loadCatalog(integration);
    } catch (e) {
      throw linearErrorToTypedError(e);
    }
  }
}
