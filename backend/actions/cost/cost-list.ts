import { count, desc } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  costFilterInputs,
  costTotals,
  costWhere,
  serializeCostRecord,
} from "../../ops/CostOps";
import { costRecords } from "../../schema/cost_records";

/**
 * `cost:list` — a project's cost records, newest first: one per claim of a
 * turn that ended, with what the agent reported spending and everything it
 * is attributable to (the session and its issue, the manager that dispatched
 * it, the runner and its owner, the issuer, the role, the agent, the
 * repository). Filtered by session, manager tree, runner, owner, issuer,
 * role, or time, with the filtered `total`. Requires membership. Paginated.
 */
export class CostList implements Action {
  name = "cost:list";
  description =
    "List what each turn of a project's agent sessions cost, newest first: tokens and US dollars as the coding agent reported them, with the session, issue, dispatching manager, runner and its owner, the person who asked, role, agent, and repository it is attributed to. Optionally filtered by session, manager session tree, runner, runner owner, issuer, role, or time; answers the filtered total too. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/costs", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend(
    costFilterInputs.shape,
  );

  /**
   * @param params - The project, filters, and pagination.
   * @returns This page of records, the filtered total, and pagination metadata.
   */
  async run(params: ActionParams<CostList>) {
    const where = costWhere(params.projectId, params);
    const [result, total] = await Promise.all([
      paginate(
        api.db.db
          .select()
          .from(costRecords)
          .where(where)
          .orderBy(desc(costRecords.endedAt), desc(costRecords.id)),
        api.db.db.select({ count: count() }).from(costRecords).where(where),
        params,
      ),
      costTotals(where),
    ]);
    return {
      costRecords: result.data.map(serializeCostRecord),
      total,
      pagination: result.pagination,
    };
  }
}
