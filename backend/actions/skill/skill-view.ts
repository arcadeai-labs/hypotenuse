import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  canWriteSkill,
  loadReadableSkill,
  serializeSkill,
  skillVersion,
} from "../../ops/SkillOps";

/**
 * `skill:view` — one skill with its current body. Needs its read access.
 */
export class SkillView implements Action {
  name = "skill:view";
  description =
    "Get one skill with its current body, arguments, access lists, and whether you may change it. A skill you cannot read answers as not found.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/skill/:skillId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    skillId: idInput("The skill"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The skill.
   */
  async run(params: ActionParams<SkillView>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const skill = await loadReadableSkill(
      api.db.db,
      params.projectId,
      params.skillId,
      tags,
    );
    const current = await skillVersion(
      api.db.db,
      skill.id,
      skill.currentVersion,
    );
    return {
      skill: {
        ...serializeSkill(skill, current),
        canWrite: canWriteSkill(skill, tags),
      },
    };
  }
}
