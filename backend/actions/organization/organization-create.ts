import { type ActionParams, HTTP_METHOD, RateLimitMiddleware } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { SessionMiddleware } from "../../middleware/session";
import { nameInput } from "../../ops/InputOps";
import {
  createOrganizationForOwner,
  organizationStanding,
  serializeOrganization,
} from "../../ops/OrganizationOps";

/**
 * `organization:create` — any signed-in person may start an organization, and
 * becomes its owner. It starts with no projects; owners create them.
 */
export class OrganizationCreate extends AuditedAction {
  name = "organization:create";
  description =
    "Create a new organization. The caller becomes its owner. It starts with no projects — create one with project:create. Requires an active session.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/organization", method: HTTP_METHOD.PUT };
  inputs = z.object({
    name: nameInput("The display name for the new organization"),
  });

  /**
   * @param tx - The transaction the organization, its owner, and the audit row share.
   * @param params - The validated inputs (`name`).
   * @param connection - The caller's connection.
   * @returns The organization and the caller's standing in it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<OrganizationCreate>,
    connection: AuditedConnection,
  ) {
    const { organization, membership } = await createOrganizationForOwner(
      tx,
      connection.session!.data.userId!,
      params.name,
    );
    const serialized = serializeOrganization(organization);
    connection.metadata.auditOrganizationId = organization.id;
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "organization";
    connection.metadata.auditTargetPath = organization.slug;
    connection.metadata.auditMetadata = {
      organizationId: organization.id,
      name: organization.name,
    };
    return {
      organization: serialized,
      standing: organizationStanding(membership),
    };
  }
}
