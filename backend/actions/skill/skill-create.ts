import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { accessListSchema, assertAccessListTags } from "../../ops/AccessOps";
import { assertNotLockedOut } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { changeNoteInput } from "../../ops/PromptSectionOps";
import {
  serializeSkill,
  skillArgumentsInput,
  skillBodyInput,
  skillDescriptionInput,
  skillNameInput,
} from "../../ops/SkillOps";
import { skills, skillVersions } from "../../schema/skills";

/**
 * `skill:create` — add a procedure to the project's skill library. Any
 * member; the creator must satisfy the access lists they set. Audited.
 */
export class SkillCreate extends AuditedAction {
  name = "skill:create";
  description =
    "Add a skill to the project's library: a name (what /<name> and use_skill call), a one-line description, its arguments (name, required, default), and a markdown template body using $1, $ARGUMENTS, and $<name>. Attach it to bots to let them use it. accessRead / accessWrite are tag lists for who may see and change it (empty: every member). Needs project membership; you must satisfy the lists you set.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/skill", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project"),
    name: skillNameInput,
    description: skillDescriptionInput,
    arguments: skillArgumentsInput.default([]),
    body: skillBodyInput,
    accessRead: accessListSchema.default([]),
    accessWrite: accessListSchema.default([]),
    changeNote: changeNoteInput.optional(),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The skill.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SkillCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    await assertAccessListTags(
      tx,
      params.projectId,
      params.accessRead,
      "accessRead",
    );
    await assertAccessListTags(
      tx,
      params.projectId,
      params.accessWrite,
      "accessWrite",
    );
    assertNotLockedOut(params.accessRead, tags, "accessRead");
    assertNotLockedOut(params.accessWrite, tags, "accessWrite");
    const [taken] = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.projectId, params.projectId),
          eq(skills.name, params.name),
        ),
      );
    if (taken) {
      throw new TypedError({
        message: `A skill named "${params.name}" already exists in this project`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    const userId = connection.session?.data.userId ?? null;
    const [skill] = await tx
      .insert(skills)
      .values({
        projectId: params.projectId,
        name: params.name,
        description: params.description,
        arguments: params.arguments,
        currentVersion: 1,
        accessRead: params.accessRead,
        accessWrite: params.accessWrite,
        createdByUserId: userId,
      })
      .returning();
    const [version] = await tx
      .insert(skillVersions)
      .values({
        skillId: skill.id,
        version: 1,
        description: params.description,
        arguments: params.arguments,
        body: params.body,
        userId,
        changeNote: params.changeNote ?? null,
      })
      .returning();
    const serialized = serializeSkill(skill, version);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "skill";
    connection.metadata.auditTargetPath = skill.name;
    return { skill: serialized };
  }
}
