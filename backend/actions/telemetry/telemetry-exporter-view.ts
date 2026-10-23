import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  exporterInProject,
  serializeTelemetryExporter,
} from "../../ops/TelemetryExporterOps";

/**
 * `telemetry-exporter:view` — one exporter: where it sends, what, and how
 * the last export went. Header names only, never values. Members may read
 * it: a runner's owner can see what their machine's work is exported at.
 */
export class TelemetryExporterView implements Action {
  name = "telemetry-exporter:view";
  description =
    "Show one telemetry exporter of a project: its endpoint, protocol, content level, signals, sample ratio, header names (never values), and its last export and last error. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/telemetry-exporter/:id", method: HTTP_METHOD.GET };
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
   * @returns The exporter.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(params: ActionParams<TelemetryExporterView>) {
    const row = await exporterInProject(
      api.db.db,
      params.projectId,
      params.id,
      false,
    );
    return { telemetryExporter: serializeTelemetryExporter(row) };
  }
}
