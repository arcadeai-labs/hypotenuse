import { count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  integrationConfigured,
  serializeIntegration,
} from "../../ops/IntegrationOps";
import { integrations, TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `integration:list` — every integration the project has, of any trigger
 * type, plus every type this deployment knows and whether it is configured,
 * so a client can offer the ones not yet connected. Requires membership.
 * Paginated.
 */
export class IntegrationList implements Action {
  name = "integration:list";
  description =
    "List the project's integrations with trigger systems (today: Linear), and every trigger type this deployment supports with whether it is configured. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/integrations", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose integrations to list"),
  });

  /**
   * @param params - The project and pagination.
   * @returns This page of integrations, pagination, and the known types.
   */
  async run(params: ActionParams<IntegrationList>) {
    const where = eq(integrations.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(integrations)
        .where(where)
        .orderBy(integrations.type, integrations.id)
        .$dynamic(),
      api.db.db.select({ count: count() }).from(integrations).where(where),
      params,
    );
    return {
      integrations: result.data.map(serializeIntegration),
      pagination: result.pagination,
      types: TRIGGER_TYPES.map((type) => ({
        type,
        configured: integrationConfigured(type),
      })),
    };
  }
}
