import { and, eq, inArray } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { revokePendingInvites } from "../../ops/InviteOps";
import {
  getAdminUserIds,
  lockProjectAdmins,
  serializeMembership,
} from "../../ops/MembershipOps";
import { serializeTag } from "../../ops/TagOps";
import { getUserById } from "../../ops/UserOps";
import { projectMemberships } from "../../schema/project_memberships";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";

/**
 * `membership:delete` — remove a member from a project, with every tag they hold
 * in it. Requires admin standing. They stay in the organization.
 *
 * The project's **last explicit admin** cannot be removed. The guard locks the
 * project row before reading the admin set, so two admins removing each other at
 * once cannot both pass.
 */
export class MembershipDelete extends AuditedAction {
  name = "membership:delete";
  description =
    "Remove a member from a project, along with the tags they hold in it; they stay in the organization. Requires admin standing in the project. The project's last admin cannot be removed — give another member the admin tag first, or delete the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/member/:userId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project to remove the member from"),
    userId: idInput("The member to remove"),
  });

  /**
   * @param tx - The transaction the guard, the deletes, and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for the last admin,
   *   or someone who is not a member.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MembershipDelete>,
    connection: AuditedConnection,
  ) {
    await lockProjectAdmins(tx, params.projectId);
    const admins = await getAdminUserIds(tx, params.projectId);
    if (admins.length === 1 && admins[0] === params.userId) {
      throw new TypedError({
        message:
          "Cannot remove the last admin of a project. Give another member the admin tag first, or delete the project.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "userId",
      });
    }

    const [existing] = await tx
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, params.userId),
          eq(projectMemberships.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new TypedError({
        message: "That user is not a member of this project",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "userId",
      });
    }

    const held = await tx
      .select({ tag: tags })
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .where(
        and(
          eq(userTags.userId, params.userId),
          eq(tags.projectId, params.projectId),
        ),
      );

    // `before` carries the tags that go with the membership: which tags a removed
    // member held cannot be reconstructed afterwards.
    connection.metadata.auditBefore = {
      ...serializeMembership(existing),
      tags: held.map((h) => serializeTag(h.tag)),
    };
    connection.metadata.auditTargetType = "membership";
    connection.metadata.auditTargetPath = (
      await getUserById(params.userId, tx)
    )?.email;

    if (held.length > 0) {
      await tx.delete(userTags).where(
        and(
          eq(userTags.userId, params.userId),
          inArray(
            userTags.tagId,
            held.map((h) => h.tag.id),
          ),
        ),
      );
    }
    await tx
      .delete(projectMemberships)
      .where(eq(projectMemberships.id, existing.id));

    // A pending invite into this project would let them straight back in.
    const removed = await getUserById(params.userId, tx);
    if (removed) {
      await revokePendingInvites(
        tx,
        connection.metadata.project!.organizationId,
        removed.email,
        params.projectId,
      );
    }
    return { success: true };
  }
}
