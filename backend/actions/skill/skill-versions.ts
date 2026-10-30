import { count, desc, eq } from "drizzle-orm";
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
import { idInput } from "../../ops/InputOps";
import { loadReadableSkill, serializeSkillVersion } from "../../ops/SkillOps";
import { skillVersions } from "../../schema/skills";

/**
 * `skill:versions` — a skill's history, newest first.
 */
export class SkillVersions implements Action {
  name = "skill:versions";
  description =
    "List a skill's versions, newest first, each with its description, arguments, body, author, and change note. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/skill/:skillId/versions",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    skillId: idInput("The skill"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The versions and pagination metadata.
   */
  async run(
    params: ActionParams<SkillVersions>,
    connection: AuditedConnection,
  ) {
    const skill = await loadReadableSkill(
      api.db.db,
      params.projectId,
      params.skillId,
      connection.metadata.callerTags ?? [],
    );
    const where = eq(skillVersions.skillId, skill.id);
    const result = await paginate(
      api.db.db
        .select()
        .from(skillVersions)
        .where(where)
        .orderBy(desc(skillVersions.version))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(skillVersions).where(where),
      params,
    );
    return {
      versions: result.data.map(serializeSkillVersion),
      pagination: result.pagination,
    };
  }
}
