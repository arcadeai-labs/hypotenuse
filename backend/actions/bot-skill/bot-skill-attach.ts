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
import {
  loadReadableSkill,
  serializeBotSkill,
  skillVersion,
} from "../../ops/SkillOps";
import { botSkills } from "../../schema/bot_skills";

/**
 * `bot-skill:attach` — let a bot use one of the project's skills, at its
 * latest version or pinned to one. Needs the bot's write access and the
 * skill's read access. Attaching again changes the pin. Audited.
 */
export class BotSkillAttach extends AuditedAction {
  name = "bot-skill:attach";
  description =
    "Attach one of the project's skills to a bot, so it appears in the bot's prompt and the bot (or a person typing /<name>) can use it. It uses the skill's latest version unless pinnedVersion names one; attaching again changes the pin (null unpins). Needs the bot's write access and the skill's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/skill",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    skillId: idInput("The skill"),
    pinnedVersion: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Use this version of the skill; null follows the latest"),
  });

  /**
   * @param tx - The transaction the upsert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The attachment.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotSkillAttach>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const skill = await loadReadableSkill(
      tx,
      params.projectId,
      params.skillId,
      tags,
    );
    if (
      params.pinnedVersion !== null &&
      !(await skillVersion(tx, skill.id, params.pinnedVersion))
    ) {
      throw new TypedError({
        message: `The skill "${skill.name}" has no version ${params.pinnedVersion}; it is at version ${skill.currentVersion}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const [existing] = await tx
      .select()
      .from(botSkills)
      .where(and(eq(botSkills.botId, bot.id), eq(botSkills.skillId, skill.id)))
      .for("update");
    const [row] = existing
      ? await tx
          .update(botSkills)
          .set({ pinnedVersion: params.pinnedVersion })
          .where(eq(botSkills.id, existing.id))
          .returning()
      : await tx
          .insert(botSkills)
          .values({
            botId: bot.id,
            skillId: skill.id,
            pinnedVersion: params.pinnedVersion,
          })
          .returning();
    const serialized = serializeBotSkill(row, skill);
    if (existing)
      connection.metadata.auditBefore = serializeBotSkill(existing, skill);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "bot-skill";
    connection.metadata.auditTargetPath = `${bot.slug}/${skill.name}`;
    return { botSkill: serialized };
  }
}
