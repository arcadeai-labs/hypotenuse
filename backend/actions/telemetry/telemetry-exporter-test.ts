import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  RateLimitMiddleware,
} from "keryx";
import { z } from "zod";
import { AdminMiddleware } from "../../middleware/rbac";
import { exporterInProject } from "../../ops/TelemetryExporterOps";
import { probeExporter } from "../../ops/TelemetryRelayOps";

/**
 * `telemetry-exporter:test` — send the collector a probe span, log record,
 * and metric now, straight from this process, and answer what it said to
 * each. Writes nothing (not even `lastError`), so it is not audited. Admin
 * only: it makes the server call out to the exporter's endpoint.
 */
export class TelemetryExporterTest implements Action {
  name = "telemetry-exporter:test";
  description =
    "Send a telemetry exporter's collector a probe — one span, one log record, and one metric, for the signals it is configured with — and report the HTTP status the collector answered for each. Changes nothing. Requires the admin tag on the project.";
  middleware = [RateLimitMiddleware, AdminMiddleware()];
  web = { route: "/telemetry-exporter/:id/test", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the exporter belongs to"),
    id: z.coerce.number().int().positive().describe("The exporter's id"),
  });

  /**
   * @param params - The project and exporter.
   * @returns Each signal's outcome: `ok`, `status`, and an error sentence.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(params: ActionParams<TelemetryExporterTest>) {
    const row = await exporterInProject(
      api.db.db,
      params.projectId,
      params.id,
      false,
    );
    const outcomes = await probeExporter(row);
    const results = Object.entries(outcomes).map(([signal, o]) => ({
      signal,
      ok: o?.ok ?? false,
      status: o?.status ?? 0,
      error: o?.error ?? null,
    }));
    return { ok: results.every((r) => r.ok), results };
  }
}
