import { and, eq, inArray } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import {
  getAdminUserIds,
  lockProjectAdmins,
  serializeMembership,
} from "../../ops/MembershipOps";
import {
  afterRunnersRevoked,
  revokeRunners,
  serializeRunner,
} from "../../ops/RunnerOps";
import { serializeTag } from "../../ops/TagOps";
import { getUserById } from "../../ops/UserOps";
import { projectMemberships } from "../../schema/project_memberships";
import { runners } from "../../schema/runners";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";

/**
 * `membership:delete` — remove a member from a project, along with every tag they
 * hold in it. Requires the admin tag on the project.
 *
 * The project's **last admin** cannot be removed: that would leave a project with
 * members but nobody able to administer it. The guard reads the admin set inside
 * the same transaction as the delete, so two concurrent removals cannot both see
 * two admins and both succeed.
 *
 * Every runner the removed member owns in the project is revoked in the same
 * transaction — their membership was those runners' authority — and their
 * daemons are told once it commits.
 */
export class MembershipDelete extends AuditedAction {
  name = "membership:delete";
  description =
    "Remove a member from a project, along with the tags they hold in it, and revoke every runner they registered in it. Requires the admin tag on the project. The project's last admin cannot be removed — promote another member first, or delete the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/membership", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to remove the member from"),
    userId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The id of the user to remove"),
  });

  /**
   * @param tx - The transaction the last-admin read, both deletes, and the audit row share.
   * @param params - The validated inputs (`projectId`, `userId`).
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns `{ success: true }` on completion.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` if the target is the last admin, or
   *   is not a member of the project.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MembershipDelete>,
    connection: AuditedConnection,
  ) {
    await lockProjectAdmins(tx, params.projectId);
    const admins = await getAdminUserIds(tx, params.projectId);
    if (admins.length === 1 && admins.includes(params.userId)) {
      throw new TypedError({
        message:
          "Cannot remove the last admin of a project. Promote another member to admin, or delete the project instead.",
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

    // Tags are project-scoped, so revoke only the ones belonging to *this*
    // project — the user may hold tags in others.
    const projectTags = await tx
      .select()
      .from(tags)
      .where(eq(tags.projectId, params.projectId));
    const tagIds = projectTags.map((t) => t.id);

    const heldTags =
      tagIds.length > 0
        ? await tx
            .select({ tagId: userTags.tagId })
            .from(userTags)
            .where(
              and(
                eq(userTags.userId, params.userId),
                inArray(userTags.tagId, tagIds),
              ),
            )
        : [];
    const heldTagIds = new Set(heldTags.map((r) => r.tagId));

    const removedUser = await getUserById(params.userId, tx);

    // `before` records what is being taken away — the membership *and* the tags
    // that go with it. Reconstructing which tags a removed member held is not
    // possible after the fact, so the row has to carry them.
    connection.metadata.auditBefore = {
      ...serializeMembership(existing),
      tags: projectTags.filter((t) => heldTagIds.has(t.id)).map(serializeTag),
    };
    connection.metadata.auditTargetType = "membership";
    connection.metadata.auditTargetPath = removedUser?.email;

    if (tagIds.length > 0) {
      await tx
        .delete(userTags)
        .where(
          and(
            eq(userTags.userId, params.userId),
            inArray(userTags.tagId, tagIds),
          ),
        );
    }

    await tx
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, params.userId),
          eq(projectMemberships.projectId, params.projectId),
        ),
      );

    const owned = await tx
      .select({ id: runners.id })
      .from(runners)
      .where(
        and(
          eq(runners.projectId, params.projectId),
          eq(runners.userId, params.userId),
        ),
      );
    const revoked = await revokeRunners(
      tx,
      owned.map((r) => r.id),
      "membership_removed",
    );
    if (revoked.length > 0) {
      connection.metadata.auditBefore = {
        ...(connection.metadata.auditBefore as Record<string, unknown>),
        revokedRunners: revoked.map((r) => serializeRunner(r)),
      };
    }

    return { success: true, revokedRunnerIds: revoked.map((r) => r.id) };
  }

  /**
   * Tell the removed member's daemons they are revoked, and delete their
   * sockets' sessions.
   * @param result - What {@link MembershipDelete.runWithAudit} returned.
   * @param params - The validated inputs.
   */
  async afterCommit(
    result: { revokedRunnerIds: number[] },
    params: ActionParams<MembershipDelete>,
  ) {
    await afterRunnersRevoked(
      result.revokedRunnerIds.map((id) => ({
        id,
        projectId: params.projectId,
      })),
    );
  }
}
