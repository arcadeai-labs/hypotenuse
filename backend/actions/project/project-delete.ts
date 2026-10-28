import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeProject } from "../../ops/ProjectOps";
import { projects } from "../../schema/projects";

/**
 * `project:delete` — permanently delete a project and everything scoped to it.
 * The delete cascades at the database (`ON DELETE cascade`) to its tags and their
 * grants, memberships, invites, settings, and notifications, so this stays one
 * statement as project-scoped tables are added. Requires admin standing.
 *
 * The audit log does **not** go with it: `audit_logs.projectId` carries no
 * foreign key, so the record of a deletion outlives the thing deleted.
 */
export class ProjectDelete extends AuditedAction {
  name = "project:delete";
  description =
    "Permanently delete a project and everything in it — its tags, memberships, invites, and settings. Requires admin standing in the project. This cannot be undone.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: idInput("The project to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ProjectDelete>,
    connection: AuditedConnection,
  ) {
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
    // `after` stays null: that asymmetry is how a deletion reads in the log.
    connection.metadata.auditBefore = serializeProject(existing);
    connection.metadata.auditTargetType = "project";
    connection.metadata.auditTargetPath = existing.slug;
    await tx.delete(projects).where(eq(projects.id, params.projectId));
    return { success: true };
  }
}
