import { and, asc, count, eq, inArray } from "drizzle-orm";
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
import { readableIds } from "../../ops/AccessOps";
import { idInput } from "../../ops/InputOps";
import {
  canWriteSkill,
  SKILL_ACCESS_LIST,
  serializeSkill,
} from "../../ops/SkillOps";
import { skills } from "../../schema/skills";

/**
 * `skill:list` — the project's skills the caller may read, by name.
 */
export class SkillList implements Action {
  name = "skill:list";
  description =
    "List the project's skills you may see, by name, with each one's description, arguments, current version, access lists, and whether you may change it. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/skills", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The skills and pagination metadata.
   */
  async run(params: ActionParams<SkillList>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const ids = await readableIds(
      api.db.db,
      SKILL_ACCESS_LIST,
      params.projectId,
      tags,
    );
    const where = and(
      eq(skills.projectId, params.projectId),
      inArray(skills.id, ids),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(skills)
        .where(where)
        .orderBy(asc(skills.name))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(skills).where(where),
      params,
    );
    return {
      skills: result.data.map((s) => ({
        ...serializeSkill(s),
        canWrite: canWriteSkill(s, tags),
      })),
      pagination: result.pagination,
    };
  }
}
