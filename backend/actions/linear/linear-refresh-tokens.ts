import { and, eq, isNull, lt, or } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
import { refreshInstallationTokens } from "../../ops/LinearOAuthOps";
import { linearInstallations } from "../../schema/linear_installations";

/**
 * `linear:refresh-tokens` — the refresh clock. Every few minutes, refresh each
 * active installation whose access token expires within the refresh window.
 *
 * Linear's tokens last 24 hours; a five-minute clock with a thirty-minute window
 * gets six attempts before one lapses, and each attempt that loses its response
 * is replayed by the next (see `refreshInstallationTokens`). Task-only, never
 * an HTTP route or an MCP tool, and unaudited: a clock is not a person's
 * decision, and the row is its own record.
 */
export class LinearRefreshTokens implements Action {
  name = "linear:refresh-tokens";
  description =
    "Refresh every active Linear installation whose access token expires soon. Runs automatically every few minutes; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default", frequency: 1000 * 60 * 5 };
  inputs = z.object({});

  /**
   * @returns How many installations were due, and how many refreshes failed.
   */
  async run() {
    const horizon = new Date(Date.now() + config.linear.refreshWindowMs);
    const due = await api.db.db
      .select({ id: linearInstallations.id })
      .from(linearInstallations)
      .where(
        and(
          eq(linearInstallations.status, "active"),
          or(
            isNull(linearInstallations.accessTokenExpiresAt),
            lt(linearInstallations.accessTokenExpiresAt, horizon),
          ),
        ),
      );

    let failed = 0;
    for (const { id } of due) {
      try {
        await refreshInstallationTokens(id);
      } catch (e) {
        failed++;
        api.logger.warn("a Linear refresh failed and will be retried", {
          installationId: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { due: due.length, failed };
  }
}
