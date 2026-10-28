import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput, nameInput } from "../../ops/InputOps";
import { serializeProject, uniqueProjectSlug } from "../../ops/ProjectOps";
import { projects } from "../../schema/projects";

/**
 * `project:edit` — rename a project; its slug follows the new name, kept unique
 * within the organization. Requires admin standing.
 */
export class ProjectEdit extends AuditedAction {
  name = "project:edit";
  description =
    "Rename a project; its slug is regenerated from the new name. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: idInput("The project to rename"),
    name: nameInput("The new display name for the project"),
  });

  /**
   * @param tx - The transaction the rename and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The updated project.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ProjectEdit>,
    connection: AuditedConnection,
  ) {
    // `before` is read inside this transaction, not taken from the copy the
    // middleware loaded on another connection before it opened.
    const [existing] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, params.projectId))
      .limit(1);
    if (!existing) {
      throw new TypedError({
        message: "Project not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    connection.metadata.auditBefore = serializeProject(existing);

    const slug =
      params.name === existing.name
        ? existing.slug
        : await uniqueProjectSlug(
            tx,
            existing.organizationId,
            params.name,
            existing.id,
          );
    const [project] = await tx
      .update(projects)
      .set({ name: params.name, slug })
      .where(eq(projects.id, params.projectId))
      .returning();

    const serialized = serializeProject(project);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "project";
    connection.metadata.auditTargetPath = project.slug;
    return { project: serialized };
  }
}
