import { count, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { OrganizationOwnerMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  lockOrganizationOwners,
  serializeOrganization,
} from "../../ops/OrganizationOps";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";

/**
 * `organization:delete` — delete an organization. Owners only, and **refused
 * while it has projects**: deleting a project takes its bots, memory, and
 * platform installs with it, and that must be a decision made (and audited) per
 * project, never a side effect of deleting the container. Its memberships and
 * pending invites go with it.
 */
export class OrganizationDelete extends AuditedAction {
  name = "organization:delete";
  description =
    "Delete an organization, its memberships, and its pending invites. Requires being an owner. Refused while the organization still has projects — delete each project first with project:delete.";
  middleware = [OrganizationOwnerMiddleware()];
  web = {
    route: "/organization/:organizationId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    organizationId: idInput("The organization to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` while it has projects.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<OrganizationDelete>,
    connection: AuditedConnection,
  ) {
    // Lock first, so a project created concurrently either lands before the
    // count or waits and then fails on the missing organization.
    await lockOrganizationOwners(tx, params.organizationId);
    const [existing] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);
    if (!existing) {
      throw new TypedError({
        message: "Organization not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    const [{ count: projectCount }] = await tx
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.organizationId, existing.id));
    if (Number(projectCount) > 0) {
      throw new TypedError({
        message: `This organization still has ${projectCount} project${Number(projectCount) === 1 ? "" : "s"}. Delete ${Number(projectCount) === 1 ? "it" : "them"} first.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "organizationId",
      });
    }

    connection.metadata.auditBefore = serializeOrganization(existing);
    connection.metadata.auditTargetType = "organization";
    connection.metadata.auditTargetPath = existing.slug;
    await tx.delete(organizations).where(eq(organizations.id, existing.id));
    return { success: true };
  }
}
