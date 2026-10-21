import { and, eq, isNull, lt, or } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
import { refreshIntegrationTokens } from "../../ops/LinearOAuthOps";
import { integrations } from "../../schema/integrations";

/**
 * `integrations:refresh-tokens` — the refresh clock. Every few minutes, refresh
 * each active integration whose access token expires within the refresh window.
 *
 * Linear's tokens last 24 hours; a five-minute clock with a thirty-minute window
 * gets six attempts before one lapses, and each attempt that loses its response
 * is replayed by the next (see `refreshIntegrationTokens`). Task-only, never
 * an HTTP route or an MCP tool, and unaudited: a clock is not a person's
 * decision, and the row is its own record.
 */
export class IntegrationsRefreshTokens implements Action {
  name = "integrations:refresh-tokens";
  description =
    "Refresh every active integration whose access token expires soon. Runs automatically every few minutes; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default", frequency: 1000 * 60 * 5 };
  inputs = z.object({});

  /**
   * @returns How many integrations were due, and how many refreshes failed.
   */
  async run() {
    const horizon = new Date(Date.now() + config.linear.refreshWindowMs);
    const due = await api.db.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          // Linear is the only type today; each type refreshes its own way.
          eq(integrations.type, "linear"),
          eq(integrations.status, "active"),
          or(
            isNull(integrations.accessTokenExpiresAt),
            lt(integrations.accessTokenExpiresAt, horizon),
          ),
        ),
      );

    let failed = 0;
    for (const { id } of due) {
      try {
        await refreshIntegrationTokens(id);
      } catch (e) {
        failed++;
        api.logger.warn("a Linear refresh failed and will be retried", {
          integrationId: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { due: due.length, failed };
  }
}
