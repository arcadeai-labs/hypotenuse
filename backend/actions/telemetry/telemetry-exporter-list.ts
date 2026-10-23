import { asc, count, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeTelemetryExporter } from "../../ops/TelemetryExporterOps";
import { telemetryExporters } from "../../schema/telemetry_exporters";

/**
 * `telemetry-exporter:list` — a project's exporters, oldest first. Members
 * may read it, so a runner's owner can see what their work is exported at;
 * only admins change it. Paginated.
 */
export class TelemetryExporterList implements Action {
  name = "telemetry-exporter:list";
  description =
    "List the OpenTelemetry collectors a project's work is exported to: each one's name, endpoint, content level, signals, sample ratio, header names (never values), and its last export and last error. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/telemetry-exporters", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose exporters to list"),
  });

  /**
   * @param params - The project and pagination.
   * @returns This page of exporters plus pagination metadata.
   */
  async run(params: ActionParams<TelemetryExporterList>) {
    const where = eq(telemetryExporters.projectId, params.projectId);
    const result = await paginate(
      api.db.db
        .select()
        .from(telemetryExporters)
        .where(where)
        .orderBy(asc(telemetryExporters.id))
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(telemetryExporters)
        .where(where),
      params,
    );
    return {
      telemetryExporters: result.data.map(serializeTelemetryExporter),
      pagination: result.pagination,
    };
  }
}
