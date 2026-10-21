import { asc, count, eq } from "drizzle-orm";
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
import { serializeRoutingRule } from "../../ops/RoutingOps";
import { routingRules } from "../../schema/routing_rules";

/**
 * `routing-rule:list` — a project's routing rules in evaluation order. The
 * first enabled rule that matches a new session decides its role; when none
 * does, the role is worker. Requires membership: every member may read how
 * work is routed, though only admins change it. Paginated.
 */
export class RoutingRuleList implements Action {
  name = "routing-rule:list";
  description =
    "List a project's routing rules in the order they are evaluated. The first enabled rule whose match holds decides whether a new Linear session is answered by a manager or a worker (and may pin a repository); with no match the role is worker. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/routing-rules", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose rules to list"),
  });

  /**
   * @param params - The project and pagination.
   * @returns This page of rules plus pagination metadata.
   */
  async run(params: ActionParams<RoutingRuleList>) {
    const where = eq(routingRules.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(routingRules)
        .where(where)
        .orderBy(asc(routingRules.position), asc(routingRules.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(routingRules).where(where),
      params,
    );
    return {
      routingRules: result.data.map(serializeRoutingRule),
      pagination: result.pagination,
    };
  }
}
