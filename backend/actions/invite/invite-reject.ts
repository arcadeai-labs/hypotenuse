import { eq } from "drizzle-orm";
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
import { SessionMiddleware } from "../../middleware/session";
import { assertEmailVerified } from "../../ops/EmailVerificationOps";
import { idInput } from "../../ops/InputOps";
import { INVITE_STATUS, isExpired, serializeInvite } from "../../ops/InviteOps";
import { getUserById } from "../../ops/UserOps";
import { projectInvites } from "../../schema/project_invites";

/**
 * `invite:reject` — the invitee declines an invite addressed to their email.
 * Ownership is proven by email match, as in `invite:accept`. Only a **pending**
 * invite can be rejected: rewriting an accepted one to `rejected` would leave the
 * membership in place while the record said it was declined. The row is kept so
 * the inviter's list shows what happened.
 */
export class InviteReject extends AuditedAction {
  name = "invite:reject";
  description =
    "Reject a pending invitation addressed to your email. Nothing is joined. Requires an active session.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/invite/:inviteId/reject", method: HTTP_METHOD.POST };
  inputs = z.object({
    inviteId: idInput("The invite to reject"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The invitee's connection.
   * @returns The rejected invite.
   * @throws {TypedError} 403 while the caller's address is unconfirmed; 404
   *   for an invite that is not the caller's; 406 when it
   *   is no longer pending or has expired.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<InviteReject>,
    connection: AuditedConnection,
  ) {
    const user = await getUserById(connection.session!.data.userId!, tx);
    // Before the invite is even looked at, so an unconfirmed address learns
    // nothing about which invites exist.
    if (user) assertEmailVerified(user);
    const [invite] = await tx
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.id, params.inviteId))
      .for("update");
    if (!user || !invite || invite.inviteeEmail !== user.email) {
      throw new TypedError({
        message: "Invite not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    if (invite.status !== INVITE_STATUS.pending || isExpired(invite)) {
      throw new TypedError({
        message: "This invite is no longer pending",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "inviteId",
      });
    }

    await tx
      .update(projectInvites)
      .set({ status: INVITE_STATUS.rejected })
      .where(eq(projectInvites.id, invite.id));
    const rejected = serializeInvite({
      ...invite,
      status: INVITE_STATUS.rejected,
    });

    connection.metadata.auditOrganizationId = invite.organizationId;
    if (invite.projectId) connection.metadata.auditProjectId = invite.projectId;
    connection.metadata.auditBefore = serializeInvite(invite);
    connection.metadata.auditAfter = rejected;
    connection.metadata.auditTargetType = "invite";
    connection.metadata.auditTargetPath = invite.inviteeEmail;
    return { invite: rejected };
  }
}
