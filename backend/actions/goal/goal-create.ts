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
  goalPriorityInput,
  goalReviewEveryInput,
  goalStatusInput,
  goalTitleInput,
  serializeGoal,
} from "../../ops/GoalOps";
import { idInput } from "../../ops/InputOps";
import { goals } from "../../schema/goals";

/**
 * `goal:create` — give a bot a goal. Needs the bot's write access. Audited.
 */
export class GoalCreate extends AuditedAction {
  name = "goal:create";
  description =
    "Give a bot a goal to work toward: a title, what done looks like, a priority, and optionally how often it should review it (seconds; the prompt asks for a review when due). Active goals are in the bot's prompt; the bot may update a goal's status and notes, but not create, retitle, or delete one. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/goal",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    title: goalTitleInput,
    description: goalDescriptionInput.default(""),
    priority: goalPriorityInput.default("medium"),
    status: goalStatusInput.default("active"),
    notes: goalNotesInput.default(""),
    reviewEverySeconds: goalReviewEveryInput.default(null),
    position: z.number().int().min(0).max(10_000).default(0),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The goal.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<GoalCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const [goal] = await tx
      .insert(goals)
      .values({
        projectId: bot.projectId,
        botId: bot.id,
        title: params.title,
        description: params.description,
        priority: params.priority,
        status: params.status,
        notes: params.notes,
        reviewEverySeconds: params.reviewEverySeconds,
        position: params.position,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();
    const serialized = serializeGoal(goal);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "goal";
    connection.metadata.auditTargetPath = `${bot.slug}/${goal.id}`;
    return { goal: serialized };
  }
}
