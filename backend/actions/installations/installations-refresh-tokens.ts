import { and, eq, sql } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/platforms";
import { refreshLinearToken } from "../../ops/LinearOps";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `installations:refresh-tokens` — refresh every active Linear installation's
 * access token that expires within `refreshBeforeMs` (six hours of its 24),
 * so a send never waits on a refresh. Each refresh runs under the
 * installation's row lock (`LinearOps.refreshLinearToken`); a transient
 * failure leaves the tokens as they were for the next run, and `invalid_grant`
 * marks the installation `error`. A clock: task-only, never an HTTP route,
 * unaudited, since nobody decided.
 */
export class InstallationsRefreshTokens implements Action {
  name = "installations:refresh-tokens";
  description =
    "Refresh platform OAuth access tokens that expire soon. Runs automatically on a timer; not exposed over HTTP.";
  mcp = { tool: false };
  task = {
    queue: "orchestrator",
    frequency: config.platforms.linear.refreshFrequencyMs,
  };
  inputs = z.object({});

  /** @returns How many were refreshed, refused, and failed. */
  async run() {
    const due = await api.db.db
      .select({ id: botInstallations.id })
      .from(botInstallations)
      .where(
        and(
          eq(botInstallations.type, "linear"),
          eq(botInstallations.status, "active"),
          sql`(${botInstallations.config}->>'accessTokenExpiresAt')::bigint < ${
            Date.now() + config.platforms.linear.refreshBeforeMs
          }`,
        ),
      );
    let refreshed = 0;
    let refused = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        const r = await refreshLinearToken(id);
        if (r.kind === "refreshed") refreshed++;
        if (r.kind === "refused") refused++;
      } catch (e) {
        failed++;
        api.logger.warn("a Linear token refresh failed; it will be retried", {
          installationId: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { refreshed, refused, failed };
  }
}
