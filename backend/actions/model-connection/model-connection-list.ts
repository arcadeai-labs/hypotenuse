import { asc, count, eq } from "drizzle-orm";
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
import { serializeModelConnection } from "../../ops/ModelOps";
import { modelConnections } from "../../schema/model_connections";

/**
 * `model-connection:list` — a project's model connections, by name, without
 * their keys. Requires membership.
 */
export class ModelConnectionList implements Action {
  name = "model-connection:list";
  description =
    "List a project's model connections by name: provider, base URL, the last four characters of each key, and whether it last worked. Keys are never returned. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/model-connections",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose model connections to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns The connections and pagination metadata.
   */
  async run(params: ActionParams<ModelConnectionList>) {
    const where = eq(modelConnections.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(modelConnections)
        .where(where)
        .orderBy(asc(modelConnections.name), asc(modelConnections.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(modelConnections).where(where),
      params,
    );
    return {
      modelConnections: result.data.map(serializeModelConnection),
      pagination: result.pagination,
    };
  }
}
