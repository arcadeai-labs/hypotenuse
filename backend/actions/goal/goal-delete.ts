import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { goalNotFound, loadGoal, serializeGoal } from "../../ops/GoalOps";
import { idInput } from "../../ops/InputOps";
import { goals } from "../../schema/goals";

/**
 * `goal:delete` — remove a goal. Needs its bot's write access. Audited.
 */
export class GoalDelete extends AuditedAction {
  name = "goal:delete";
  description =
    "Delete a goal. To keep it on record instead, set its status to achieved or dropped. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/goal/:goalId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    goalId: idInput("The goal"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The deleted goal.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<GoalDelete>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const goal = await loadGoal(tx, params.projectId, params.goalId, {
      lock: true,
    });
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      goal.botId,
      tags,
    ).catch(() => {
      throw goalNotFound();
    });
    assertCanWriteBot(bot, tags);
    await tx.delete(goals).where(eq(goals.id, goal.id));
    const serialized = serializeGoal(goal);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "goal";
    connection.metadata.auditTargetPath = `${bot.slug}/${goal.id}`;
    return { goal: serialized };
  }
}
