import { eq } from "drizzle-orm";
import { type Action, type ActionParams, api } from "keryx";
import { z } from "zod";
import { idInput } from "../../ops/InputOps";
import {
  enqueueCapabilitiesForServer,
  refreshCatalog,
} from "../../ops/McpCatalogOps";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-server:refresh-catalog` — re-list one server's tools and store the
 * catalog and status. Task-only (fanned out by `mcp-servers:refresh`), never
 * an HTTP route; unaudited machine work recorded on `mcp_servers`.
 */
export class McpServerRefreshCatalog implements Action {
  name = "mcp-server:refresh-catalog";
  description =
    "Re-list one MCP server's tools and store them. Runs in the background; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default" };
  inputs = z.object({ mcpServerId: idInput("The server") });

  /**
   * @param params - The server.
   * @returns Whether it worked and whether the catalog changed.
   */
  async run(params: ActionParams<McpServerRefreshCatalog>) {
    const [row] = await api.db.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, params.mcpServerId));
    if (!row || !row.enabled || (row.authMode === "oauth" && !row.oauthTokens))
      return { ok: false, changed: false };
    const result = await refreshCatalog(row);
    if (result.changed) await enqueueCapabilitiesForServer(row.id);
    return { ok: result.ok, changed: result.changed };
  }
}
