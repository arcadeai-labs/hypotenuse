import { type ActionParams, HTTP_METHOD, RateLimitMiddleware } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { OrganizationOwnerMiddleware } from "../../middleware/rbac";
import { idInput, nameInput } from "../../ops/InputOps";
import { serializeMembership } from "../../ops/MembershipOps";
import { createProjectForOwner, serializeProject } from "../../ops/ProjectOps";

/**
 * `project:create` — an organization owner creates a project in it, and becomes
 * its first explicit admin. Owners create projects; members are invited to them.
 *
 * The audit row is scoped with `auditProjectId`, because the id being audited
 * does not exist until the insert — without it a project's first log entry would
 * be filed under no project.
 */
export class ProjectCreate extends AuditedAction {
  name = "project:create";
  description =
    "Create a project in an organization. The caller becomes its first member and receives its reserved admin tag. Requires being an owner of the organization; to join someone else's project, ask an admin of it for an invite.";
  middleware = [RateLimitMiddleware, OrganizationOwnerMiddleware()];
  web = { route: "/project", method: HTTP_METHOD.PUT };
  inputs = z.object({
    organizationId: idInput("The organization to create the project in"),
    name: nameInput("The display name for the new project"),
  });

  /**
   * @param tx - The transaction the bootstrap and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The project and the caller's membership.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ProjectCreate>,
    connection: AuditedConnection,
  ) {
    const { project, membership } = await createProjectForOwner(
      tx,
      params.organizationId,
      connection.session!.data.userId!,
      params.name,
    );
    const serialized = serializeProject(project);
    connection.metadata.auditProjectId = project.id;
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "project";
    connection.metadata.auditTargetPath = project.slug;
    return { project: serialized, membership: serializeMembership(membership) };
  }
}
