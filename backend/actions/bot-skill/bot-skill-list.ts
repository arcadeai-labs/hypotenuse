import { asc, count, eq } from "drizzle-orm";
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
import { idInput } from "../../ops/InputOps";
import { loadBotSkillView } from "../../ops/SkillOps";
import { botSkills } from "../../schema/bot_skills";
import { skills } from "../../schema/skills";

/**
 * `bot-skill:list` — the skills attached to a bot, by name. Needs the bot's
 * read access.
 */
export class BotSkillList implements Action {
  name = "bot-skill:list";
  description =
    "List the skills attached to a bot, by name, with the version each uses (pinned, or the latest). Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/skills",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The attachments and pagination metadata.
   */
  async run(params: ActionParams<BotSkillList>, connection: AuditedConnection) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    const where = eq(botSkills.botId, bot.id);
    const result = await paginate(
      api.db.db
        .select({ binding: botSkills, skill: skills })
        .from(botSkills)
        .innerJoin(skills, eq(skills.id, botSkills.skillId))
        .where(where)
        .orderBy(asc(skills.name))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(botSkills).where(where),
      params,
    );
    return {
      botSkills: await Promise.all(
        result.data.map((r) => loadBotSkillView(api.db.db, r.binding, r.skill)),
      ),
      pagination: result.pagination,
    };
  }
}
