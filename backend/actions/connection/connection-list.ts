import { asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { describeConnectionKinds } from "../../connections/registry";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeProjectConnection } from "../../ops/SandboxCredentialOps";
import { projectConnections } from "../../schema/project_connections";

/**
 * `connection:list` — a project's connections, without their secrets, and
 * the kinds a project may add. Requires membership.
 */
export class ConnectionList implements Action {
  name = "connection:list";
  description =
    "List a project's connections to sandbox provider accounts: kind, name, their non-secret fields, the last four characters of each token, and whether it last worked — plus the kinds that may be added and the fields each takes. Tokens are never returned. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/connections", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose connections to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns The connections, the kinds, and pagination metadata.
   */
  async run(params: ActionParams<ConnectionList>) {
    const where = eq(projectConnections.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(projectConnections)
        .where(where)
        .orderBy(asc(projectConnections.kind), asc(projectConnections.id))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(projectConnections)
        .where(where),
      params,
    );
    return {
      connections: result.data.map(serializeProjectConnection),
      kinds: describeConnectionKinds(),
      pagination: result.pagination,
    };
  }
}
