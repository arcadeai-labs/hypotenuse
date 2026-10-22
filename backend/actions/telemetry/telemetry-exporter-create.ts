import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import {
  assertNameFree,
  checkedEndpoint,
  contentInput,
  endpointInput,
  exporterNameInput,
  flagInput,
  headersInput,
  protocolInput,
  resourceAttributesInput,
  sampleRatioInput,
  sealHeaders,
  serializeTelemetryExporter,
  signalsInput,
} from "../../ops/TelemetryExporterOps";
import { forgetProjectTelemetry } from "../../ops/TelemetryOps";
import { ensureExporterGroup } from "../../ops/TelemetryRelayOps";
import { telemetryExporters } from "../../schema/telemetry_exporters";

/**
 * `telemetry-exporter:create` — point the project's telemetry at an
 * OpenTelemetry collector. Admin only: it decides what of the project's work
 * (at `content` and `full`, its prompts and source code) leaves for a third
 * party. The endpoint must be public `https`; the headers are sealed and
 * never answered. The exporter receives what is observed from now on.
 */
export class TelemetryExporterCreate extends AuditedAction {
  name = "telemetry-exporter:create";
  description =
    "Add an OpenTelemetry collector this project's work is exported to over OTLP/HTTP: traces, metrics, and logs of every turn from the server, the runner's daemon, and the coding agent itself. Choose the content level (metadata, content, or full — full sends prompts and source code), the signals, the trace sample ratio, and headers (write-only; e.g. a vendor API key). The endpoint must be a public https URL. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/telemetry-exporter", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to export from"),
    name: exporterNameInput.describe(
      "What the exporter is called, unique in the project",
    ),
    endpoint: endpointInput,
    protocol: protocolInput
      .optional()
      .describe("http/protobuf (default) or http/json"),
    headers: headersInput
      .optional()
      .describe(
        "Headers sent with every export, e.g. an API key; never shown again",
      ),
    signals: signalsInput
      .optional()
      .describe(
        "Which of traces, metrics, and logs to send (default all three)",
      ),
    content: contentInput
      .optional()
      .describe("metadata (default), content, or full"),
    agentNative: flagInput
      .optional()
      .describe("Capture the coding agent's own telemetry (default true)"),
    traceSampleRatio: sampleRatioInput
      .optional()
      .describe(
        "0–1: the share of turns whose traces and logs are kept (default 1)",
      ),
    resourceAttributes: resourceAttributesInput
      .optional()
      .describe("Extra resource attributes stamped on everything sent"),
    enabled: flagInput.optional().describe("Whether it exports (default true)"),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The exporter.
   * @param connection - The caller's connection.
   * @returns The exporter, without header values.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a refused
   *   endpoint or a taken name.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<TelemetryExporterCreate>,
    connection: AuditedConnection,
  ) {
    const endpoint = await checkedEndpoint(params.endpoint);
    await assertNameFree(tx, params.projectId, params.name);
    const [row] = await tx
      .insert(telemetryExporters)
      .values({
        projectId: params.projectId,
        name: params.name,
        endpoint,
        ...(params.protocol ? { protocol: params.protocol } : {}),
        ...sealHeaders(params.headers ?? {}),
        ...(params.signals ? { signals: params.signals } : {}),
        ...(params.content ? { content: params.content } : {}),
        ...(params.agentNative !== undefined
          ? { agentNative: params.agentNative }
          : {}),
        ...(params.traceSampleRatio !== undefined
          ? { traceSampleRatio: params.traceSampleRatio }
          : {}),
        ...(params.resourceAttributes
          ? { resourceAttributes: params.resourceAttributes }
          : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      })
      .returning();
    const serialized = serializeTelemetryExporter(row);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "telemetry_exporter";
    connection.metadata.auditTargetPath = row.name;
    return { telemetryExporter: serialized };
  }

  /**
   * Give the exporter its place in the project's stream, and let this
   * process see it at once.
   * @param result - The created exporter.
   */
  async afterCommit(result: unknown): Promise<void> {
    const { telemetryExporter } = result as {
      telemetryExporter: { id: number; projectId: number };
    };
    forgetProjectTelemetry(telemetryExporter.projectId);
    await ensureExporterGroup(
      telemetryExporter.projectId,
      telemetryExporter.id,
    );
  }
}
