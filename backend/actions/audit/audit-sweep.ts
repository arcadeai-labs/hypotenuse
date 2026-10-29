import { lt } from "drizzle-orm";
import { type Action, api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/audit";
import { auditLogs } from "../../schema/audit_logs";

/**
 * `audit:sweep` — delete audit rows older than `AUDIT_RETENTION_DAYS`. A daily
 * clock: task-only, never an HTTP route, never an MCP tool, and not audited
 * itself — a retention sweep is the clock acting, not somebody's decision, and
 * the setting that armed it is the deployment's.
 *
 * It is the only writer that ever deletes an audit row, and nothing updates
 * one.
 */
export class AuditSweep implements Action {
  name = "audit:sweep";
  description =
    "Delete audit-log rows older than the retention window. Runs automatically once a day; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "orchestrator", frequency: 24 * 60 * 60 * 1000 };
  inputs = z.object({});

  /**
   * Delete everything past the retention cutoff.
   * @returns How many rows were deleted.
   */
  async run() {
    const cutoff = new Date(
      Date.now() - config.audit.retentionDays * 24 * 60 * 60 * 1000,
    );
    const deleted = await api.db.db
      .delete(auditLogs)
      .where(lt(auditLogs.createdAt, cutoff))
      .returning({ id: auditLogs.id });
    if (deleted.length > 0) {
      api.logger.info("purged expired audit rows", {
        deleted: deleted.length,
      });
    }
    return { deleted: deleted.length };
  }
}
