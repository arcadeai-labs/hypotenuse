import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import {
  exporterInProject,
  serializeTelemetryExporter,
} from "../../ops/TelemetryExporterOps";
import { forgetProjectTelemetry } from "../../ops/TelemetryOps";
import { dropExporterGroup } from "../../ops/TelemetryRelayOps";
import { telemetryExporters } from "../../schema/telemetry_exporters";

/**
 * `telemetry-exporter:delete` — stop exporting to a collector and forget its
 * headers. What waited in the stream for it is dropped. Admin only.
 */
export class TelemetryExporterDelete extends AuditedAction {
  name = "telemetry-exporter:delete";
  description =
    "Delete a telemetry exporter: nothing more is sent to that collector, and its headers are forgotten. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/telemetry-exporter/:id", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the exporter belongs to"),
    id: z.coerce.number().int().positive().describe("The exporter's id"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The exporter.
   * @param connection - The caller's connection.
   * @returns `{ success: true }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<TelemetryExporterDelete>,
    connection: AuditedConnection,
  ) {
    const row = await exporterInProject(tx, params.projectId, params.id);
    await tx
      .delete(telemetryExporters)
      .where(eq(telemetryExporters.id, row.id));
    connection.metadata.auditBefore = serializeTelemetryExporter(row);
    connection.metadata.auditTargetType = "telemetry_exporter";
    connection.metadata.auditTargetPath = row.name;
    return { success: true };
  }

  /**
   * Remove its consumer group and backoff, and let this process see it gone.
   * @param _result - Unused.
   * @param params - The project and exporter.
   */
  async afterCommit(
    _result: unknown,
    params: Record<string, unknown>,
  ): Promise<void> {
    forgetProjectTelemetry(Number(params.projectId));
    await dropExporterGroup(Number(params.projectId), Number(params.id));
  }
}
