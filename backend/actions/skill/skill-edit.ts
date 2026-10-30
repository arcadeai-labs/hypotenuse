import { and, eq, ne } from "drizzle-orm";
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
  assertCanWriteSkill,
  loadReadableSkill,
  serializeSkill,
  skillArgumentsInput,
  skillBodyInput,
  skillDescriptionInput,
  skillNameInput,
  skillVersion,
} from "../../ops/SkillOps";
import { type NewSkill, skills, skillVersions } from "../../schema/skills";

/**
 * `skill:edit` — change a skill. A change to its description, arguments, or
 * body is a new version; bots pinned to an older one keep it. Needs the
 * skill's write access (or admin). Audited.
 */
export class SkillEdit extends AuditedAction {
  name = "skill:edit";
  description =
    "Change a skill: its name, description, arguments, or body (any of the last three saves a new version — bots pinned to an older version keep using it), or its access lists. Only the fields sent change. Needs the skill's write access, or a project admin.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/skill/:skillId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    skillId: idInput("The skill"),
    name: skillNameInput.optional(),
    description: skillDescriptionInput.optional(),
    arguments: skillArgumentsInput.optional(),
    body: skillBodyInput.optional(),
    accessRead: accessListSchema.optional(),
    accessWrite: accessListSchema.optional(),
    changeNote: changeNoteInput.optional(),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The skill.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SkillEdit>,
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
    connection.metadata.auditBefore = serializeSkill(skill, current);
    if (params.accessRead !== undefined) {
      await assertAccessListTags(
        tx,
        params.projectId,
        params.accessRead,
        "accessRead",
      );
      assertNotLockedOut(params.accessRead, tags, "accessRead");
    }
    if (params.accessWrite !== undefined) {
      await assertAccessListTags(
        tx,
        params.projectId,
        params.accessWrite,
        "accessWrite",
      );
      assertNotLockedOut(params.accessWrite, tags, "accessWrite");
    }
    if (params.name !== undefined && params.name !== skill.name) {
      const [taken] = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(
          and(
            eq(skills.projectId, params.projectId),
            eq(skills.name, params.name),
            ne(skills.id, skill.id),
          ),
        );
      if (taken) {
        throw new TypedError({
          message: `A skill named "${params.name}" already exists in this project`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        });
      }
    }
    const description = params.description ?? skill.description;
    const args = params.arguments ?? skill.arguments;
    const body = params.body ?? current?.body ?? "";
    const newVersion =
      description !== current?.description ||
      JSON.stringify(args) !== JSON.stringify(current?.arguments) ||
      body !== current?.body;
    const changes: Partial<NewSkill> = {};
    if (params.name !== undefined) changes.name = params.name;
    if (params.accessRead !== undefined) changes.accessRead = params.accessRead;
    if (params.accessWrite !== undefined)
      changes.accessWrite = params.accessWrite;
    let version = current;
    if (newVersion) {
      const next = skill.currentVersion + 1;
      [version] = await tx
        .insert(skillVersions)
        .values({
          skillId: skill.id,
          version: next,
          description,
          arguments: args,
          body,
          userId: connection.session?.data.userId ?? null,
          changeNote: params.changeNote ?? null,
        })
        .returning();
      Object.assign(changes, {
        description,
        arguments: args,
        currentVersion: next,
      });
    }
    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(skills)
            .set(changes)
            .where(eq(skills.id, skill.id))
            .returning()
        : [skill];
    const serialized = serializeSkill(updated, version);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "skill";
    connection.metadata.auditTargetPath = updated.name;
    return { skill: serialized };
  }
}
