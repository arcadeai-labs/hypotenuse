import { asc, count, eq, sql } from "drizzle-orm";
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
import {
  connectionsById,
  missingRequiredAliases,
  RESERVED_MODEL_ALIASES,
  serializeModelAlias,
} from "../../ops/ModelOps";
import { modelAliases } from "../../schema/model_aliases";

/**
 * `model-alias:list` — a project's named models, `default` and `fast` first,
 * and which of those two are still missing. Requires membership: a member
 * choosing a bot's model picks from this list.
 */
export class ModelAliasList implements Action {
  name = "model-alias:list";
  description =
    "List a project's model aliases (default and fast first, then by name), each with its connection and model id, plus missingRequired: the required names (default, fast) not defined yet. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/model-aliases", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose model aliases to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns The aliases, the missing required names, and pagination metadata.
   */
  async run(params: ActionParams<ModelAliasList>) {
    const where = eq(modelAliases.projectId, params.projectId);
    const reservedFirst = sql`CASE ${modelAliases.name} ${sql.join(
      RESERVED_MODEL_ALIASES.map((name, i) => sql`WHEN ${name} THEN ${i}`),
      sql` `,
    )} ELSE ${RESERVED_MODEL_ALIASES.length} END`;
    const result = await paginate(
      api.db.db
        .select()
        .from(modelAliases)
        .where(where)
        .orderBy(reservedFirst, asc(modelAliases.name))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(modelAliases).where(where),
      params,
    );
    const connections = await connectionsById(
      api.db.db,
      result.data.map((a) => a.connectionId),
    );
    return {
      modelAliases: result.data.map((a) =>
        serializeModelAlias(a, connections.get(a.connectionId)),
      ),
      missingRequired: await missingRequiredAliases(
        api.db.db,
        params.projectId,
      ),
      pagination: result.pagination,
    };
  }
}
