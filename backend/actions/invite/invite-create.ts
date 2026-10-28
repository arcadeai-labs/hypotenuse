import { and, eq, inArray } from "drizzle-orm";
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
import { OrganizationMemberMiddleware } from "../../middleware/rbac";
import { emailInput, idInput } from "../../ops/InputOps";
import {
  INVITE_STATUS,
  INVITE_TTL_MS,
  serializeInvite,
} from "../../ops/InviteOps";
import { isAdmin, resolveProjectAccess } from "../../ops/MembershipOps";
import { getUserById } from "../../ops/UserOps";
import { projectInvites } from "../../schema/project_invites";
import { tags } from "../../schema/tags";

/**
 * `invite:create` — invite an email address into an organization.
 *
 * | `projectId` | Kind | Who may send it | Accepting grants |
 * |---|---|---|---|
 * | given | project invite | admin standing in that project | the organization membership if missing, the project membership, the tags |
 * | omitted | organization invite | an owner of the organization | the organization membership only |
 *
 * Gated at the `org-member` level because the finer rule depends on which kind
 * it is; the check is here, and a refusal is the same 403 the project and
 * organization gates give. No email is sent: the invite appears in-app for the
 * invitee on their next sign-in, and expires after five days.
 */
export class InviteCreate extends AuditedAction {
  name = "invite:create";
  description =
    "Invite a person (by email) into an organization. With projectId it is a project invite — requires admin standing in that project, and may grant project tags on acceptance; accepting also adds them to the organization. Without projectId it is an organization invite — requires being an owner, and grants only organization membership. The invite appears in-app for the invitee and expires after five days.";
  middleware = [RateLimitMiddleware, OrganizationMemberMiddleware()];
  web = {
    route: "/organization/:organizationId/invite",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    organizationId: idInput("The organization to invite the person into"),
    projectId: idInput(
      "The project to invite them into; omit for an organization invite",
    ).optional(),
    inviteeEmail: emailInput("Email address of the person to invite"),
    tagIds: z
      .array(z.coerce.number().int().positive())
      .default([])
      .describe(
        "Ids of the project's tags to grant on acceptance (project invites only)",
      ),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (organization set by middleware).
   * @returns The created invite.
   * @throws {TypedError} 403 without the standing the kind needs; 406 for tags
   *   outside the project, or tags on an organization invite.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<InviteCreate>,
    connection: AuditedConnection,
  ) {
    const userId = connection.session!.data.userId!;
    const organization = connection.metadata.organization!;
    let projectName: string | null = null;

    if (params.projectId) {
      const access = await resolveProjectAccess(userId, params.projectId, tx);
      // A project in another organization is refused exactly like one the
      // caller cannot administer, so invite ids cannot probe for projects.
      if (
        !access ||
        access.project.organizationId !== organization.id ||
        !isAdmin(access.callerTags)
      ) {
        throw new TypedError({
          message: `Inviting someone to a project requires admin standing in it`,
          type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
        });
      }
      projectName = access.project.name;
      connection.metadata.viaOrganizationOwner = access.viaOrganizationOwner;

      if (params.tagIds.length > 0) {
        const found = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(
              eq(tags.projectId, params.projectId),
              inArray(tags.id, params.tagIds),
            ),
          );
        if (found.length !== new Set(params.tagIds).size) {
          throw new TypedError({
            message: "One or more tagIds do not belong to this project",
            type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
            key: "tagIds",
          });
        }
      }
    } else {
      if (connection.metadata.organizationMembership?.role !== "owner") {
        throw new TypedError({
          message:
            "Inviting someone to the organization itself requires being an owner. A project admin can invite them to a project instead.",
          type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
        });
      }
      if (params.tagIds.length > 0) {
        throw new TypedError({
          message:
            "Tags belong to a project. Pass projectId to grant tags, or omit tagIds.",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "tagIds",
        });
      }
    }

    const inviter = await getUserById(userId, tx);
    const [invite] = await tx
      .insert(projectInvites)
      .values({
        organizationId: organization.id,
        projectId: params.projectId ?? null,
        inviterUserId: userId,
        inviteeEmail: params.inviteeEmail,
        tagIds: params.tagIds,
        status: INVITE_STATUS.pending,
        inviterEmail: inviter?.email ?? "",
        organizationName: organization.name,
        projectName,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();

    const serialized = serializeInvite(invite);
    if (invite.projectId) connection.metadata.auditProjectId = invite.projectId;
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "invite";
    connection.metadata.auditTargetPath = invite.inviteeEmail;
    return { invite: serialized };
  }
}
