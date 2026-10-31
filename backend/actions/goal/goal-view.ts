import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { goalNotFound, loadGoal, serializeGoal } from "../../ops/GoalOps";
import { idInput } from "../../ops/InputOps";

/**
 * `goal:view` — one goal. Needs its bot's read access.
 */
export class GoalView implements Action {
  name = "goal:view";
  description =
    "Get one goal: title, description, status, priority, notes, review interval, and whether a review is due. Needs the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/goal/:goalId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    goalId: idInput("The goal"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The goal.
   */
  async run(params: ActionParams<GoalView>, connection: AuditedConnection) {
    const goal = await loadGoal(api.db.db, params.projectId, params.goalId);
    await loadReadableBot(
      api.db.db,
      params.projectId,
      goal.botId,
      connection.metadata.callerTags ?? [],
    ).catch(() => {
      throw goalNotFound();
    });
    return { goal: serializeGoal(goal) };
  }
}
