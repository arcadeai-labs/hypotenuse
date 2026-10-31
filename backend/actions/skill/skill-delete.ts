import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertCanWriteSkill,
  loadReadableSkill,
  serializeSkill,
  skillVersion,
} from "../../ops/SkillOps";
import { skills } from "../../schema/skills";

/**
 * `skill:delete` — remove a skill from the library, and from every bot it was
 * attached to. Needs the skill's write access. Audited.
 */
export class SkillDelete extends AuditedAction {
  name = "skill:delete";
  description =
    "Delete a skill from the project's library; every bot it was attached to loses it. Needs the skill's write access, or a project admin.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/skill/:skillId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    skillId: idInput("The skill"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The deleted skill.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SkillDelete>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const skill = await loadReadableSkill(
      tx,
      params.projectId,
      params.skillId,
      tags,
      { lock: true },
    );
    assertCanWriteSkill(skill, tags);
    const current = await skillVersion(tx, skill.id, skill.currentVersion);
    const serialized = serializeSkill(skill, current);
    await tx.delete(skills).where(eq(skills.id, skill.id));
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "skill";
    connection.metadata.auditTargetPath = skill.name;
    return { skill: serialized };
  }
}
