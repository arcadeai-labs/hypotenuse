import { asc, count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { OrganizationMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeOrganizationMembership } from "../../ops/OrganizationOps";
import { serializeUser } from "../../ops/UserOps";
import { organizationMemberships } from "../../schema/organization_memberships";
import { users } from "../../schema/users";

/**
 * `organization-membership:list` — an organization's members and their roles.
 * Emails are included because members of an organization are peers. Which
 * projects each member is in is **not**: a member who is not in a project must
 * not learn that it exists.
 */
export class OrganizationMembershipList implements Action {
  name = "organization-membership:list";
  description =
    "List the members of an organization with their profile and role (owner or member), owners first. Requires membership in the organization. Paginated.";
  middleware = [OrganizationMemberMiddleware()];
  web = {
    route: "/organization/:organizationId/members",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    organizationId: idInput("The organization whose members to list"),
  });

  /**
   * @param params - `organizationId` plus pagination inputs.
   * @returns The members plus pagination metadata.
   */
  async run(params: ActionParams<OrganizationMembershipList>) {
    const where = eq(
      organizationMemberships.organizationId,
      params.organizationId,
    );
    const result = await paginate(
      api.db.db
        .select({ membership: organizationMemberships, user: users })
        .from(organizationMemberships)
        .innerJoin(users, eq(organizationMemberships.userId, users.id))
        .where(where)
        // `owner` sorts after `member`, so descending puts owners first.
        .orderBy(
          desc(organizationMemberships.role),
          asc(users.name),
          asc(users.id),
        )
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(organizationMemberships)
        .where(where),
      params,
    );
    return {
      memberships: result.data.map((row) => ({
        ...serializeOrganizationMembership(row.membership),
        user: serializeUser(row.user),
      })),
      pagination: result.pagination,
    };
  }
}
