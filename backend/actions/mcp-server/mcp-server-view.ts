import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  loadMcpServer,
  serializeCatalogTool,
  serializeMcpServer,
} from "../../ops/McpServerOps";

/**
 * `mcp-server:view` — one server and its cached tool catalog. Requires
 * membership.
 */
export class McpServerView implements Action {
  name = "mcp-server:view";
  description =
    "View one MCP server and its tool catalog as last listed: each tool's name, description, input schema, and annotations (readOnlyHint and the like, which are the server's claims). Credentials are never returned. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server"),
  });

  /**
   * @param params - The inputs.
   * @returns The server and its tools.
   */
  async run(params: ActionParams<McpServerView>) {
    const row = await loadMcpServer(
      api.db.db,
      params.projectId,
      params.mcpServerId,
    );
    return {
      mcpServer: serializeMcpServer(row),
      tools: row.toolsCache.map((t) => serializeCatalogTool(row.name, t)),
    };
  }
}
