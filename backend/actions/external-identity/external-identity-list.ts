import { and, count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeExternalIdentity } from "../../ops/IdentityOps";
import { getIntegration } from "../../ops/IntegrationOps";
import { externalIdentities } from "../../schema/external_identities";
import { TRIGGER_TYPES } from "../../schema/integrations";
import { users } from "../../schema/users";

/**
 * `external-identity:list` — which Hypotenuse user each person in the
 * project's trigger workspace is (a Linear user, today), and how the link was
 * made. Routing reads it to prefer the issuer's own runners. Requires
 * membership. Paginated.
 */
export class ExternalIdentityList implements Action {
  name = "external-identity:list";
  description =
    "List the links between people in a project's Linear workspace and Hypotenuse users (how each was made: e-mail match, Linear sign-in, or an admin). Routing prefers the runners of the person who started a session. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/external-identities", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose identities to list"),
    type: z
      .enum(TRIGGER_TYPES)
      .default("linear")
      .describe("The trigger system, e.g. linear"),
    userId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only identities linked to this Hypotenuse user"),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @returns This page of identities plus pagination metadata.
   */
  async run(params: ActionParams<ExternalIdentityList>) {
    const integration = await getIntegration(params.projectId, params.type);
    if (!integration) {
      return {
        externalIdentities: [],
        pagination: {
          page: params.page,
          limit: params.limit,
          total: 0,
          pages: 0,
        },
      };
    }
    const where = and(
      eq(externalIdentities.integrationId, integration.id),
      params.userId ? eq(externalIdentities.userId, params.userId) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({
          identity: externalIdentities,
          name: users.name,
          email: users.email,
        })
        .from(externalIdentities)
        .innerJoin(users, eq(users.id, externalIdentities.userId))
        .where(where)
        .orderBy(
          desc(externalIdentities.createdAt),
          desc(externalIdentities.id),
        )
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(externalIdentities)
        .where(where),
      params,
    );
    return {
      externalIdentities: result.data.map((r) =>
        serializeExternalIdentity(r.identity, { name: r.name, email: r.email }),
      ),
      pagination: result.pagination,
    };
  }
}
