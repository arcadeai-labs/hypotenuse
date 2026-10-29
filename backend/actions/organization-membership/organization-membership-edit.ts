import { and, eq } from "drizzle-orm";
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
  assertNotLastOwner,
  lockOrganizationOwners,
  serializeOrganizationMembership,
} from "../../ops/OrganizationOps";
import { getUserById } from "../../ops/UserOps";
import {
  ORGANIZATION_ROLES,
  organizationMemberships,
} from "../../schema/organization_memberships";

/**
 * `organization-membership:edit` — promote a member to owner, or demote an owner
 * to member. Owners only.
 *
 * Demoting the **last owner** is refused, under a `FOR UPDATE` lock on the
 * organization row taken before the owner set is read: without it, two owners
 * demoting each other at once both read two owners and both succeed.
 */
export class OrganizationMembershipEdit extends AuditedAction {
  name = "organization-membership:edit";
  description =
    "Change an organization member's role to owner or member. Requires being an owner. The organization's last owner cannot be demoted — make someone else an owner first.";
  middleware = [OrganizationOwnerMiddleware()];
  web = {
    route: "/organization/:organizationId/member/:userId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    organizationId: idInput("The organization"),
    userId: idInput("The member whose role to change"),
    role: z.enum(ORGANIZATION_ROLES).describe("The new role: owner or member"),
  });

  /**
   * @param tx - The transaction the guard, the update, and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns The updated membership.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the user is not
   *   a member, or is the last owner being demoted.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<OrganizationMembershipEdit>,
    connection: AuditedConnection,
  ) {
    await lockOrganizationOwners(tx, params.organizationId);
    const [existing] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, params.organizationId),
          eq(organizationMemberships.userId, params.userId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new TypedError({
        message: "That user is not a member of this organization",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "userId",
      });
    }
    if (existing.role === "owner" && params.role !== "owner") {
      await assertNotLastOwner(tx, params.organizationId, params.userId);
    }

    const [membership] = await tx
      .update(organizationMemberships)
      .set({ role: params.role })
      .where(eq(organizationMemberships.id, existing.id))
      .returning();

    connection.metadata.auditBefore = serializeOrganizationMembership(existing);
    connection.metadata.auditAfter =
      serializeOrganizationMembership(membership);
    connection.metadata.auditTargetType = "organization-membership";
    connection.metadata.auditTargetPath = (
      await getUserById(params.userId, tx)
    )?.email;
    return { membership: serializeOrganizationMembership(membership) };
  }
}
