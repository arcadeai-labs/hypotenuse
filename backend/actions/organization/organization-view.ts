import {
  type Action,
  type ActionParams,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  OrganizationMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { idInput } from "../../ops/InputOps";
import {
  organizationStanding,
  serializeOrganization,
} from "../../ops/OrganizationOps";

/**
 * `organization:view` — one organization the caller belongs to, with their
 * standing in it. Standing is the server's answer, so a client never decides
 * "am I an owner here" itself.
 */
export class OrganizationView implements Action {
  name = "organization:view";
  description =
    "Get one organization you belong to, and your standing in it (whether you are an owner). Requires membership in the organization.";
  middleware = [OrganizationMemberMiddleware()];
  web = {
    route: "/organization/:organizationId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    organizationId: idInput("The organization to view"),
  });

  /**
   * @param _params - The validated inputs, consumed by the middleware.
   * @param connection - The caller's connection (organization set by middleware).
   * @returns The organization and the caller's standing.
   */
  async run(
    _params: ActionParams<OrganizationView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    return {
      organization: serializeOrganization(connection.metadata.organization!),
      standing: organizationStanding(
        connection.metadata.organizationMembership!,
      ),
    };
  }
}
