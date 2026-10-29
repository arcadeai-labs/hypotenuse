import { asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { type SessionImpl, SessionMiddleware } from "../../middleware/session";
import {
  organizationStanding,
  serializeOrganization,
} from "../../ops/OrganizationOps";
import { organizationMemberships } from "../../schema/organization_memberships";
import { organizations } from "../../schema/organizations";

/**
 * `organization:list` — the organizations the caller belongs to, by name, each
 * with their standing. Backs the organization switcher. The caller's own
 * memberships are the filter, so it needs only a session.
 */
export class OrganizationList implements Action {
  name = "organization:list";
  description =
    "List the organizations you belong to, by name, each with your standing in it. Requires an active session. Paginated.";
  middleware = [SessionMiddleware];
  web = { route: "/organizations", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 });

  /**
   * @param params - Pagination inputs.
   * @param connection - The caller's connection.
   * @returns The organizations plus pagination metadata.
   */
  async run(
    params: ActionParams<OrganizationList>,
    connection: Connection<SessionImpl>,
  ) {
    const where = eq(
      organizationMemberships.userId,
      connection.session!.data.userId!,
    );
    const result = await paginate(
      api.db.db
        .select({
          organization: organizations,
          membership: organizationMemberships,
        })
        .from(organizationMemberships)
        .innerJoin(
          organizations,
          eq(organizationMemberships.organizationId, organizations.id),
        )
        .where(where)
        .orderBy(asc(organizations.name), asc(organizations.id))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(organizationMemberships)
        .where(where),
      params,
    );
    return {
      organizations: result.data.map((row) => ({
        ...serializeOrganization(row.organization),
        standing: organizationStanding(row.membership),
      })),
      pagination: result.pagination,
    };
  }
}
