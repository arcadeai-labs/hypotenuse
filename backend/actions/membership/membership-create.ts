import { and, eq } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { emailInput, idInput } from "../../ops/InputOps";
import { serializeMembership } from "../../ops/MembershipOps";
import { organizationMemberships } from "../../schema/organization_memberships";
import { projectMemberships } from "../../schema/project_memberships";
import { users } from "../../schema/users";

/**
 * `membership:create` — an admin adds an existing **member of the organization**
 * to a project. Project membership requires organization membership, so someone
 * outside the organization is refused with the next move: invite them.
 *
 * The organization membership row is locked `FOR UPDATE` while the project
 * membership is written, so a concurrent removal from the organization either
 * commits first (and this finds no membership) or waits for this to commit (and
 * then removes the new project membership too).
 */
export class MembershipCreate extends AuditedAction {
  name = "membership:create";
  description =
    "Add a member of the project's organization (by email) to the project. Someone outside the organization must be invited instead, with invite:create. Requires admin standing in the project.";
  middleware = [RateLimitMiddleware, AdminMiddleware()];
  web = { route: "/project/:projectId/member", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project to add the person to"),
    email: emailInput("Email of the organization member to add"),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (project set by middleware).
   * @returns The created membership.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the person is
   *   not in the organization, or already a member.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MembershipCreate>,
    connection: AuditedConnection,
  ) {
    const project = connection.metadata.project!;
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, params.email))
      .limit(1);
    const [organizationMembership] = user
      ? await tx
          .select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                project.organizationId,
              ),
              eq(organizationMemberships.userId, user.id),
            ),
          )
          .for("update")
      : [];

    // One refusal for "no such account" and "not in the organization": the
    // next move is the same, and it does not say who has an account.
    if (!user || !organizationMembership) {
      throw new TypedError({
        message:
          "That person is not a member of this project's organization. Invite them to the organization first, with invite:create.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "email",
      });
    }

    const [existing] = await tx
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, user.id),
          eq(projectMemberships.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TypedError({
        message: "That person is already a member of this project",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "email",
      });
    }

    const [membership] = await tx
      .insert(projectMemberships)
      .values({ userId: user.id, projectId: params.projectId })
      .returning();
    const serialized = serializeMembership(membership);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "membership";
    connection.metadata.auditTargetPath = user.email;
    return { membership: serialized };
  }
}
