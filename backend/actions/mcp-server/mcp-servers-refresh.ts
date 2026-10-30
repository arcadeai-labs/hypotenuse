import { eq } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/mcp";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `mcp-servers:refresh` — hourly, fan out `mcp-server:refresh-catalog` to
 * every enabled server. A clock: task-only, never an HTTP route, unaudited.
 */
export class McpServersRefresh implements Action {
  name = "mcp-servers:refresh";
  description =
    "Re-list every enabled MCP server's tools, server by server. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: config.mcp.refreshFrequencyMs };
  inputs = z.object({});

  /** @returns The servers fanned out to. */
  async run() {
    const rows = await api.db.db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true));
    if (rows.length > 0) {
      await api.actions.fanOut(
        "mcp-server:refresh-catalog",
        rows.map((r) => ({ mcpServerId: r.id })),
        "default",
      );
    }
    return { mcpServerIds: rows.map((r) => r.id) };
  }
}
