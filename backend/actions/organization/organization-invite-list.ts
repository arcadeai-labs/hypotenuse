import { count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { OrganizationOwnerMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeInvite } from "../../ops/InviteOps";
import { projectInvites } from "../../schema/project_invites";

/**
 * `organization:invite-list` — every invite in an organization, organization
 * invites and every project's alike, newest first. Owners only: it lists email
 * addresses of people who are not members yet, across projects a member may not
 * see.
 */
export class OrganizationInviteList implements Action {
  name = "organization:invite-list";
  description =
    "List every invitation in an organization — organization invites and project invites — in any status, newest first. Requires being an owner. Paginated.";
  middleware = [OrganizationOwnerMiddleware()];
  web = {
    route: "/organization/:organizationId/invites",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    organizationId: idInput("The organization whose invites to list"),
  });

  /**
   * @param params - `organizationId` plus pagination inputs.
   * @returns The invites plus pagination metadata.
   */
  async run(params: ActionParams<OrganizationInviteList>) {
    const where = eq(projectInvites.organizationId, params.organizationId);
    const result = await paginate(
      api.db.db
        .select()
        .from(projectInvites)
        .where(where)
        .orderBy(desc(projectInvites.createdAt), desc(projectInvites.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(projectInvites).where(where),
      params,
    );
    return {
      invites: result.data.map(serializeInvite),
      pagination: result.pagination,
    };
  }
}
