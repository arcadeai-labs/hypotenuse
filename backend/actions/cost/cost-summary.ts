import {
  type Action,
  type ActionParams,
  HTTP_METHOD,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  COST_DIMENSIONS,
  costFilterInputs,
  costSummary,
} from "../../ops/CostOps";

/**
 * `cost:summary` — a project's cost records totalled by one dimension
 * (session, manager tree, issue, runner, runner owner, issuer, role, agent,
 * repository, or UTC day), most expensive first, with the filtered total.
 * A group's `unpricedTurns` counts claims whose agent reported no cost:
 * Hypotenuse never prices tokens itself. Requires membership. Paginated by
 * group.
 */
export class CostSummary implements Action {
  name = "cost:summary";
  description =
    "Total what a project's agent sessions cost, grouped by session, root-session (a manager and the workers it dispatched), issue, runner, owner (the runner's owner), issuer (who asked), role, agent, repository, or day (UTC), most expensive first, with the overall total. Each group counts turns, tokens, US dollars as the agents reported them, and turns whose agent reported no cost. Takes the same filters as cost:list. Requires membership in the project. Paginated by group.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/costs/summary", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 })
    .extend(costFilterInputs.shape)
    .extend({
      by: z
        .enum(COST_DIMENSIONS)
        .default("session")
        .describe("What to group the turns by"),
    });

  /**
   * @param params - The project, dimension, filters, and pagination.
   * @returns This page of groups, the filtered total, and pagination metadata.
   */
  async run(params: ActionParams<CostSummary>) {
    const { groups, groupCount, total } = await costSummary(
      params.projectId,
      params.by,
      params,
      params,
    );
    return {
      by: params.by,
      groups,
      total,
      pagination: {
        page: params.page,
        limit: params.limit,
        total: groupCount,
        pages: Math.ceil(groupCount / params.limit),
      },
    };
  }
}
