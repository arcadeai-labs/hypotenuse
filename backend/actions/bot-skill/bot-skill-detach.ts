import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { loadBotSkillView, skillNotFound } from "../../ops/SkillOps";
import { botSkills } from "../../schema/bot_skills";
import { skills } from "../../schema/skills";

/**
 * `bot-skill:detach` — take a skill away from a bot. Needs the bot's write
 * access. Audited.
 */
export class BotSkillDetach extends AuditedAction {
  name = "bot-skill:detach";
  description =
    "Take a skill away from a bot: it leaves the bot's prompt, and neither the bot nor /<name> can use it there. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/skill/:skillId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    skillId: idInput("The skill"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The removed attachment.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotSkillDetach>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const [skill] = await tx
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, params.skillId),
          eq(skills.projectId, params.projectId),
        ),
      );
    if (!skill) throw skillNotFound();
    const [row] = await tx
      .delete(botSkills)
      .where(and(eq(botSkills.botId, bot.id), eq(botSkills.skillId, skill.id)))
      .returning();
    if (!row) {
      throw new TypedError({
        message: `${bot.name} does not have the skill "${skill.name}"`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const serialized = await loadBotSkillView(tx, row, skill);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "bot-skill";
    connection.metadata.auditTargetPath = `${bot.slug}/${skill.name}`;
    return { botSkill: serialized };
  }
}
