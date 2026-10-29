import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeMembership } from "../../ops/MembershipOps";
import { serializeTag } from "../../ops/TagOps";
import { serializeUser } from "../../ops/UserOps";
import { projectMemberships } from "../../schema/project_memberships";
import { tags } from "../../schema/tags";
import { userTags } from "../../schema/user_tags";
import { users } from "../../schema/users";

/**
 * `membership:list` — a project's members, each with their profile and the tags
 * they hold in it, by name. Emails are included because members of a project are
 * peers; this is the roster an admin manages tags from. Organization owners who
 * never joined the project are not members, and are not listed.
 */
export class MembershipList implements Action {
  name = "membership:list";
  description =
    "List the members of a project, each with their profile and the tags they hold in it, ordered by name. Organization owners also have admin standing in every project but are listed only if they joined it. Requires member standing in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/members", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose members to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns The members (with user and tags) plus pagination metadata.
   */
  async run(params: ActionParams<MembershipList>) {
    const where = eq(projectMemberships.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select({ membership: projectMemberships, user: users })
        .from(projectMemberships)
        .innerJoin(users, eq(projectMemberships.userId, users.id))
        .where(where)
        .orderBy(asc(users.name), asc(users.id))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(projectMemberships)
        .where(where),
      params,
    );

    // One query for the whole page's tags, not one per member.
    const userIds = result.data.map((row) => row.user.id);
    const grants =
      userIds.length > 0
        ? await api.db.db
            .select({ userId: userTags.userId, tag: tags })
            .from(userTags)
            .innerJoin(tags, eq(userTags.tagId, tags.id))
            .where(
              and(
                eq(tags.projectId, params.projectId),
                inArray(userTags.userId, userIds),
              ),
            )
            .orderBy(asc(tags.name))
        : [];

    return {
      memberships: result.data.map((row) => ({
        ...serializeMembership(row.membership),
        user: serializeUser(row.user),
        tags: grants
          .filter((g) => g.userId === row.user.id)
          .map((g) => serializeTag(g.tag)),
      })),
      pagination: result.pagination,
    };
  }
}
