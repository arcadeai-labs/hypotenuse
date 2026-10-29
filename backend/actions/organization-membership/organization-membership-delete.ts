import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { OrganizationMemberMiddleware } from "../../middleware/rbac";
import { writeAuditLog } from "../../ops/AuditOps";
import { idInput } from "../../ops/InputOps";
import {
  assertNotLastOwner,
  assertStillOwner,
  getOrganizationMembership,
  lockOrganizationOwners,
  removeOrganizationMember,
  serializeOrganizationMembership,
} from "../../ops/OrganizationOps";
import { getUserById } from "../../ops/UserOps";

/**
 * `organization-membership:delete` — an owner removes a member, or a member
 * leaves. Gated at the `org-member` level because leaving is open to everyone;
 * removing **someone else** is checked here and needs an owner.
 *
 * One transaction removes the organization membership and, with it, every
 * project membership and tag the person held in the organization — a project
 * membership without an organization membership is the state the containment
 * rule forbids. Guards, in lock order: the organization's last owner, then the
 * last explicit admin of each affected project.
 */
export class OrganizationMembershipDelete extends AuditedAction {
  name = "organization-membership:delete";
  description =
    "Remove a member from an organization, or leave it yourself (pass your own userId). Removes their membership and tags in every project of the organization too. Removing someone else requires being an owner. The last owner cannot leave or be removed, and nobody can be removed while they are the last holder of the admin tag in one of its projects.";
  middleware = [OrganizationMemberMiddleware()];
  web = {
    route: "/organization/:organizationId/member/:userId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    organizationId: idInput("The organization"),
    userId: idInput("The member to remove; your own id to leave"),
  });

  /**
   * @param tx - The transaction every removal, guard, and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns What was removed.
   * @throws {TypedError} 403 when a non-owner removes someone else; 406 for the guards.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<OrganizationMembershipDelete>,
    connection: AuditedConnection,
  ) {
    const callerId = connection.session!.data.userId!;
    if (
      params.userId !== callerId &&
      connection.metadata.organizationMembership?.role !== "owner"
    ) {
      throw new TypedError({
        message: "Only an owner can remove someone else from this organization",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }

    await lockOrganizationOwners(tx, params.organizationId);
    // The check above read the caller's role before this lock; an owner
    // demoted in the meantime must not finish removing someone else.
    if (params.userId !== callerId) {
      await assertStillOwner(tx, params.organizationId, callerId);
    }
    const target = await getOrganizationMembership(
      tx,
      params.organizationId,
      params.userId,
    );
    if (target?.role === "owner") {
      await assertNotLastOwner(tx, params.organizationId, params.userId);
    }

    const removed = await removeOrganizationMember(
      tx,
      params.organizationId,
      params.userId,
    );

    const email = (await getUserById(params.userId, tx))?.email;

    // The organization row has no project, so each project the person was
    // removed from gets its own row: a project's log must show who left it,
    // whichever door they left by.
    for (const projectId of removed.projectIds) {
      await writeAuditLog(tx, {
        actorType: "user",
        userId: callerId,
        organizationId: params.organizationId,
        projectId,
        action: "membership:delete",
        targetType: "membership",
        targetPath: email,
        metadata: {
          projectId,
          userId: params.userId,
          cascadedFrom: this.name,
          organizationId: params.organizationId,
        },
      });
    }

    connection.metadata.auditBefore = {
      ...serializeOrganizationMembership(removed.membership),
      projectIds: removed.projectIds,
      tagIds: removed.tagIds,
    };
    connection.metadata.auditTargetType = "organization-membership";
    connection.metadata.auditTargetPath = email;
    connection.metadata.auditMetadata = {
      organizationId: params.organizationId,
      userId: params.userId,
      left: params.userId === callerId,
      removedFromProjectIds: removed.projectIds,
    };
    return { success: true, removedFromProjectIds: removed.projectIds };
  }
}
