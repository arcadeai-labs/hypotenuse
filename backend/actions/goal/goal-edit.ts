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
import {
  goalDescriptionInput,
  goalNotesInput,
  goalNotFound,
  goalPriorityInput,
  goalReviewEveryInput,
  goalStatusInput,
  goalTitleInput,
  loadGoal,
  serializeGoal,
} from "../../ops/GoalOps";
import { idInput } from "../../ops/InputOps";
import { goals, type NewGoal } from "../../schema/goals";

/**
 * `goal:edit` — change any part of a goal. Needs its bot's write access.
 * Audited.
 */
export class GoalEdit extends AuditedAction {
  name = "goal:edit";
  description =
    "Change a goal: its title, description, priority, status, notes, review interval, or position. Only the fields sent change. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/goal/:goalId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    goalId: idInput("The goal"),
    title: goalTitleInput.optional(),
    description: goalDescriptionInput.optional(),
    priority: goalPriorityInput.optional(),
    status: goalStatusInput.optional(),
    notes: goalNotesInput.optional(),
    reviewEverySeconds: goalReviewEveryInput.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The goal.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<GoalEdit>,
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
    connection.metadata.auditBefore = serializeGoal(goal);
    const changes: Partial<NewGoal> = {};
    for (const key of [
      "title",
      "description",
      "priority",
      "status",
      "notes",
      "reviewEverySeconds",
      "position",
    ] as const) {
      if (params[key] !== undefined) {
        (changes as Record<string, unknown>)[key] = params[key];
      }
    }
    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(goals)
            .set(changes)
            .where(eq(goals.id, goal.id))
            .returning()
        : [goal];
    const serialized = serializeGoal(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "goal";
    connection.metadata.auditTargetPath = `${bot.slug}/${goal.id}`;
    return { goal: serialized };
  }
}
