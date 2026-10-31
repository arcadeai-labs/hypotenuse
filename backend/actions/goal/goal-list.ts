import { and, asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { goalStatusInput, serializeGoal } from "../../ops/GoalOps";
import { idInput } from "../../ops/InputOps";
import { goals } from "../../schema/goals";

/**
 * `goal:list` — a bot's goals, in position order. Needs the bot's read access.
 */
export class GoalList implements Action {
  name = "goal:list";
  description =
    "List a bot's goals with their status, priority, notes, and whether a review is due; optionally only one status. Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/goals",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    status: goalStatusInput.optional(),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The goals and pagination metadata.
   */
  async run(params: ActionParams<GoalList>, connection: AuditedConnection) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    const where = and(
      eq(goals.botId, bot.id),
      params.status ? eq(goals.status, params.status) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(goals)
        .where(where)
        .orderBy(asc(goals.position), asc(goals.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(goals).where(where),
      params,
    );
    const now = new Date();
    return {
      goals: result.data.map((g) => serializeGoal(g, now)),
      pagination: result.pagination,
    };
  }
}
