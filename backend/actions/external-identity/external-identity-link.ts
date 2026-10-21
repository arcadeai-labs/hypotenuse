import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { serializeExternalIdentity } from "../../ops/IdentityOps";
import { getIntegration } from "../../ops/IntegrationOps";
import { externalIdentities } from "../../schema/external_identities";
import { TRIGGER_TYPES } from "../../schema/integrations";
import { projectMemberships } from "../../schema/project_memberships";
import { users } from "../../schema/users";

/**
 * `external-identity:link` — an admin says which project member a person in
 * the trigger workspace is (`linkedVia = admin`), replacing any earlier link
 * for that person. A preference for routing, never an authorization: it only
 * reorders runners already eligible in the same project.
 */
export class ExternalIdentityLink extends AuditedAction {
  name = "external-identity:link";
  description =
    "Link a person in the project's Linear workspace (by Linear user id) to a member of the project, so sessions they start prefer that member's runners. Replaces any earlier link for that Linear user. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/external-identity", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: z.coerce.number().int().positive().describe("The project"),
    type: z
      .enum(TRIGGER_TYPES)
      .default("linear")
      .describe("The trigger system, e.g. linear"),
    userId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The Hypotenuse user (a member of the project)"),
    externalUserId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe("The person's user id in the trigger system"),
    externalName: z
      .string()
      .trim()
      .max(255)
      .optional()
      .describe("Their name there, for display"),
    externalEmail: z
      .string()
      .trim()
      .max(320)
      .optional()
      .describe("Their e-mail there, for display"),
  });

  /**
   * @param tx - The transaction the write and its audit row share.
   * @param params - Who is whom.
   * @param connection - The caller's connection.
   * @returns The identity.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the project
   *   has no such integration or the user is not a member.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ExternalIdentityLink>,
    connection: AuditedConnection,
  ) {
    const integration = await getIntegration(params.projectId, params.type);
    if (!integration || integration.status === "revoked") {
      throw new TypedError({
        message: `This project has no ${params.type} connection`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "type",
      });
    }
    const [member] = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.userId, users.id),
          eq(projectMemberships.projectId, params.projectId),
        ),
      )
      .where(eq(users.id, params.userId))
      .limit(1);
    if (!member) {
      throw new TypedError({
        message: "That user is not a member of this project",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "userId",
      });
    }
    const [before] = await tx
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.integrationId, integration.id),
          eq(externalIdentities.externalUserId, params.externalUserId),
        ),
      )
      .for("update");
    const values = {
      userId: member.id,
      externalName: params.externalName ?? before?.externalName ?? null,
      externalEmail: params.externalEmail ?? before?.externalEmail ?? null,
      linkedVia: "admin" as const,
    };
    const [row] = before
      ? await tx
          .update(externalIdentities)
          .set(values)
          .where(eq(externalIdentities.id, before.id))
          .returning()
      : await tx
          .insert(externalIdentities)
          .values({
            type: integration.type,
            integrationId: integration.id,
            externalUserId: params.externalUserId,
            ...values,
          })
          .returning();
    const serialized = serializeExternalIdentity(row, member);
    connection.metadata.auditBefore = before
      ? serializeExternalIdentity(before)
      : undefined;
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "external_identity";
    connection.metadata.auditTargetPath = `${integration.type}:${params.externalUserId}`;
    return { externalIdentity: serialized };
  }
}
