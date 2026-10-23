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
  assertNameFree,
  checkedEndpoint,
  contentInput,
  endpointInput,
  exporterInProject,
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
import { telemetryExporters } from "../../schema/telemetry_exporters";

/**
 * `telemetry-exporter:edit` — change an exporter. Omitting `headers` keeps
 * them; `headers: {}` clears them; any other value replaces them whole.
 * Admin only.
 */
export class TelemetryExporterEdit extends AuditedAction {
  name = "telemetry-exporter:edit";
  description =
    "Change a telemetry exporter: its name, endpoint, protocol, content level, signals, sample ratio, resource attributes, whether it captures the agent's own telemetry, or whether it is enabled. Omit headers to keep them, pass {} to clear them, or pass new ones to replace them. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/telemetry-exporter/:id", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the exporter belongs to"),
    id: z.coerce.number().int().positive().describe("The exporter's id"),
    name: exporterNameInput.optional().describe("A new name"),
    endpoint: endpointInput.optional(),
    protocol: protocolInput.optional().describe("http/protobuf or http/json"),
    headers: headersInput
      .optional()
      .describe(
        "New headers replacing the old; {} clears them; omit to keep them",
      ),
    signals: signalsInput.optional().describe("Which signals to send"),
    content: contentInput.optional().describe("metadata, content, or full"),
    agentNative: flagInput
      .optional()
      .describe("Capture the coding agent's own telemetry"),
    traceSampleRatio: sampleRatioInput.optional().describe("0–1"),
    resourceAttributes: resourceAttributesInput
      .optional()
      .describe("Replaces the extra resource attributes"),
    enabled: flagInput.optional().describe("false pauses it; true resumes it"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The exporter and what to change.
   * @param connection - The caller's connection.
   * @returns The exporter.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`, or
   *   `CONNECTION_ACTION_PARAM_VALIDATION` for a refused endpoint or name.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<TelemetryExporterEdit>,
    connection: AuditedConnection,
  ) {
    const before = await exporterInProject(tx, params.projectId, params.id);
    if (params.name !== undefined)
      await assertNameFree(tx, params.projectId, params.name, before.id);
    const endpoint =
      params.endpoint !== undefined
        ? await checkedEndpoint(params.endpoint)
        : undefined;
    const [after] = await tx
      .update(telemetryExporters)
      .set({
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(params.protocol !== undefined ? { protocol: params.protocol } : {}),
        ...(params.headers !== undefined ? sealHeaders(params.headers) : {}),
        ...(params.signals !== undefined ? { signals: params.signals } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.agentNative !== undefined
          ? { agentNative: params.agentNative }
          : {}),
        ...(params.traceSampleRatio !== undefined
          ? { traceSampleRatio: params.traceSampleRatio }
          : {}),
        ...(params.resourceAttributes !== undefined
          ? { resourceAttributes: params.resourceAttributes }
          : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      })
      .where(eq(telemetryExporters.id, before.id))
      .returning();
    connection.metadata.auditBefore = serializeTelemetryExporter(before);
    connection.metadata.auditAfter = serializeTelemetryExporter(after);
    connection.metadata.auditTargetType = "telemetry_exporter";
    connection.metadata.auditTargetPath = after.name;
    return { telemetryExporter: serializeTelemetryExporter(after) };
  }

  /**
   * Let this process see the change at once.
   * @param _result - Unused.
   * @param params - The project.
   */
  async afterCommit(
    _result: unknown,
    params: Record<string, unknown>,
  ): Promise<void> {
    forgetProjectTelemetry(Number(params.projectId));
  }
}
