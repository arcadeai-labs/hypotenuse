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
import { serializeMcpServer } from "../../ops/McpServerOps";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:list` — a project's MCP servers, by name, without credentials.
 * Requires membership.
 */
export class McpServerList implements Action {
  name = "mcp-server:list";
  description =
    "List a project's MCP servers by name: URL, auth mode, header names (never values), status, and how many tools each offers. Credentials are never returned. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/mcp-servers", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose servers to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @returns The servers and pagination metadata.
   */
  async run(params: ActionParams<McpServerList>) {
    const where = eq(mcpServers.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(mcpServers)
        .where(where)
        .orderBy(asc(mcpServers.name), asc(mcpServers.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(mcpServers).where(where),
      params,
    );
    return {
      mcpServers: result.data.map(serializeMcpServer),
      pagination: result.pagination,
    };
  }
}
