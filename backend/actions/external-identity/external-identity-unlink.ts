import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeExternalIdentity } from "../../ops/IdentityOps";
import { isAdmin } from "../../ops/MembershipOps";
import { externalIdentities } from "../../schema/external_identities";
import { integrations } from "../../schema/integrations";

/**
 * `external-identity:unlink` — remove a link between a person in the trigger
 * workspace and a Hypotenuse user: your own, or (as an admin) anyone's. An
 * e-mail match removed this way is made again the next time that person
 * starts a session; an admin who wants it gone for good links them elsewhere.
 */
export class ExternalIdentityUnlink extends AuditedAction {
  name = "external-identity:unlink";
  description =
    "Remove a link between a person in the project's Linear workspace and a Hypotenuse user. Members may remove their own links; admins may remove anyone's.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/external-identity/:id", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce.number().int().positive().describe("The project"),
    id: z.coerce.number().int().positive().describe("The identity's id"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The identity.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_CHANNEL_AUTHORIZATION`
   *   for someone else's link without the admin tag.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ExternalIdentityUnlink>,
    connection: AuditedConnection,
  ) {
    const [found] = await tx
      .select({
        identity: externalIdentities,
        projectId: integrations.projectId,
      })
      .from(externalIdentities)
      .innerJoin(
        integrations,
        eq(integrations.id, externalIdentities.integrationId),
      )
      .where(eq(externalIdentities.id, params.id))
      .for("update", { of: externalIdentities });
    const identity =
      found && found.projectId === params.projectId ? found.identity : null;
    if (!identity) {
      throw new TypedError({
        message: "Identity not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const self = identity.userId === connection.session!.data.userId;
    if (!self && !isAdmin(connection.metadata.callerTags ?? [])) {
      throw new TypedError({
        message: "Only the linked user or a project admin can remove this link",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    await tx
      .delete(externalIdentities)
      .where(eq(externalIdentities.id, identity.id));
    connection.metadata.auditBefore = serializeExternalIdentity(identity);
    connection.metadata.auditTargetType = "external_identity";
    connection.metadata.auditTargetPath = `${identity.type}:${identity.externalUserId}`;
    return { success: true };
  }
}
