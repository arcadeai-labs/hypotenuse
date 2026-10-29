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
import { SessionMiddleware } from "../../middleware/session";
import { assertEmailVerified } from "../../ops/EmailVerificationOps";
import { idInput } from "../../ops/InputOps";
import { INVITE_STATUS, isExpired, serializeInvite } from "../../ops/InviteOps";
import { serializeMembership } from "../../ops/MembershipOps";
import { serializeOrganizationMembership } from "../../ops/OrganizationOps";
import { getUserById } from "../../ops/UserOps";
import { organizationMemberships } from "../../schema/organization_memberships";
import { organizations } from "../../schema/organizations";
import { projectInvites } from "../../schema/project_invites";
import { projectMemberships } from "../../schema/project_memberships";
import { projects } from "../../schema/projects";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";

/**
 * `invite:accept` — the invitee accepts an invite addressed to their email. In
 * one transaction: the organization membership (created as `member` if missing),
 * then for a project invite the project membership and each still-valid tag, and
 * the invite is marked accepted.
 *
 * Ownership is proven by **email match**, not by a token in the URL: the invite
 * id is not a secret, and a caller can only act on an invite addressed to the
 * address they signed in with.
 *
 * Idempotent: accepting something already granted another way converges. The
 * organization membership is inserted `ON CONFLICT DO NOTHING` and then locked
 * `FOR UPDATE`, so a concurrent removal from the organization cannot interleave
 * with the project membership written under it.
 */
export class InviteAccept extends AuditedAction {
  name = "invite:accept";
  description =
    "Accept a pending invitation addressed to your email. Joins you to its organization (as a member, if you are not in it already) and, for a project invite, to the project with the invite's tags. Requires an active session.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/invite/:inviteId/accept", method: HTTP_METHOD.POST };
  inputs = z.object({
    inviteId: idInput("The invite to accept"),
  });

  /**
   * @param tx - The transaction every grant and the audit row share.
   * @param params - The validated inputs.
   * @param connection - The invitee's connection.
   * @returns The organization membership, the project membership (if any), and
   *   the accepted invite.
   * @throws {TypedError} 403 while the caller's address is unconfirmed; 404
   *   for an invite that is not the caller's; 406 when it
   *   is expired or already answered.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<InviteAccept>,
    connection: AuditedConnection,
  ) {
    const user = await getUserById(connection.session!.data.userId!, tx);
    // Before the invite is even looked at, so an unconfirmed address learns
    // nothing about which invites exist.
    if (user) assertEmailVerified(user);

    // Lock order is organization, then project, then invite — the order
    // removing someone (from the organization or the project) and deleting
    // either take. Reading the invite first only to learn its tenants, then
    // taking `KEY SHARE` on their rows, means a concurrent removal or deletion
    // either finishes before this goes on (and the re-read below sees the
    // invite revoked or gone) or waits for this to commit.
    const [peek] = await tx
      .select({
        organizationId: projectInvites.organizationId,
        projectId: projectInvites.projectId,
      })
      .from(projectInvites)
      .where(eq(projectInvites.id, params.inviteId));
    if (peek) {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, peek.organizationId))
        .for("key share");
      if (peek.projectId) {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, peek.projectId))
          .for("key share");
      }
    }
    const [invite] = await tx
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.id, params.inviteId))
      .for("update");

    // The same refusal for "no such invite" and "not yours", so invite ids
    // cannot be probed for which tenants exist.
    if (!user || !invite || invite.inviteeEmail !== user.email) {
      throw new TypedError({
        message: "Invite not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    if (invite.status !== INVITE_STATUS.pending || isExpired(invite)) {
      throw new TypedError({
        message:
          "This invite is no longer valid — it was answered, withdrawn, or has expired. Ask whoever sent it for a new one.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "inviteId",
      });
    }

    const inserted = await tx
      .insert(organizationMemberships)
      .values({ organizationId: invite.organizationId, userId: user.id })
      .onConflictDoNothing()
      .returning({ id: organizationMemberships.id });
    const [organizationMembership] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, invite.organizationId),
          eq(organizationMemberships.userId, user.id),
        ),
      )
      .for("update");
    if (!organizationMembership) {
      // Unreachable while every removal locks the organization row first; a
      // typed answer rather than a 500 if that ever stops being true.
      throw new TypedError({
        message: "The organization changed while accepting. Try again.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "inviteId",
      });
    }

    let membership: typeof projectMemberships.$inferSelect | undefined;
    let membershipAlreadyExisted = false;
    const grantedTagIds: number[] = [];
    if (invite.projectId) {
      const projectId = invite.projectId;
      const joined = await tx
        .insert(projectMemberships)
        .values({ userId: user.id, projectId })
        .onConflictDoNothing()
        .returning({ id: projectMemberships.id });
      membershipAlreadyExisted = joined.length === 0;
      [membership] = await tx
        .select()
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.userId, user.id),
            eq(projectMemberships.projectId, projectId),
          ),
        );

      for (const tagId of invite.tagIds) {
        // Only tags that still belong to this project: a tag can be deleted
        // between the invite and its acceptance.
        const [tag] = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, tagId), eq(tags.projectId, projectId)))
          .limit(1);
        if (!tag) continue;
        const granted = await tx
          .insert(userTags)
          .values({ userId: user.id, tagId })
          .onConflictDoNothing()
          .returning({ id: userTags.id });
        if (granted.length > 0) grantedTagIds.push(tagId);
      }
    }

    await tx
      .update(projectInvites)
      .set({ status: INVITE_STATUS.accepted })
      .where(eq(projectInvites.id, invite.id));
    const accepted = serializeInvite({
      ...invite,
      status: INVITE_STATUS.accepted,
    });

    connection.metadata.auditOrganizationId = invite.organizationId;
    if (invite.projectId) connection.metadata.auditProjectId = invite.projectId;
    connection.metadata.auditBefore = serializeInvite(invite);
    connection.metadata.auditAfter = accepted;
    connection.metadata.auditTargetType = "invite";
    connection.metadata.auditTargetPath = invite.inviteeEmail;
    // What was actually granted is not derivable from the invite: tags may have
    // been deleted, and memberships may already have existed.
    connection.metadata.auditMetadata = {
      inviteId: invite.id,
      organizationId: invite.organizationId,
      projectId: invite.projectId,
      joinedOrganization: inserted.length > 0,
      membershipAlreadyExisted,
      grantedTagIds,
    };

    return {
      organizationMembership: serializeOrganizationMembership(
        organizationMembership,
      ),
      membership: membership ? serializeMembership(membership) : null,
      invite: accepted,
    };
  }
}
