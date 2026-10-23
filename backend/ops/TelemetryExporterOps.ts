import {
  CONTENT_LEVELS,
  OTLP_CONTENT_TYPES,
  OTLP_SIGNALS,
} from "@hypotenuse/protocol";
import { and, eq } from "drizzle-orm";
import { api, ErrorType, secret, TypedError } from "keryx";
import { z } from "zod";
import {
  type TelemetryExporter,
  telemetryExporters,
} from "../schema/telemetry_exporters";
import { decryptSecret, encryptSecret } from "./CryptoOps";
import { endpointRefusal, normalizeEndpoint } from "./EndpointSafetyOps";
import type { TxHandle } from "./ProjectOps";

/**
 * Telemetry exporters as the actions see them: their inputs, their one
 * serializer, and the sealed headers. The serializer has no field a header
 * value fits in — `headerNames` only — and nothing outside this file and
 * `TelemetryRelayOps` opens the seal.
 */

/** An exporter's name. */
export const exporterNameInput = z
  .string()
  .trim()
  .min(1, "An exporter needs a name")
  .max(64, "An exporter name is at most 64 characters");

/** An endpoint as typed. */
export const endpointInput = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .describe(
    "The collector's OTLP/HTTP base URL, e.g. https://otlp.example.com",
  );

/** A header name: what HTTP allows, and not one the relay sets itself. */
const headerName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "not a valid header name")
  .refine(
    (n) =>
      !["content-type", "content-encoding", "content-length", "host"].includes(
        n.toLowerCase(),
      ),
    "set by the relay",
  );

/**
 * Collector headers — a credential, usually a vendor API key. Write-only:
 * redacted from audit rows, sealed at rest, never answered.
 */
export const headersInput = secret(
  z
    .record(headerName, z.string().max(8192))
    .refine((h) => Object.keys(h).length <= 32, "at most 32 headers"),
);

/** Which signals to send. */
export const signalsInput = z
  .array(z.enum(OTLP_SIGNALS))
  .min(1, "Send at least one signal")
  .max(3)
  .transform((s) => [...new Set(s)]);

/** OTLP/HTTP's two encodings. */
export const protocolInput = z.enum(
  Object.keys(OTLP_CONTENT_TYPES) as ["http/protobuf", "http/json"],
);

/** A content level. */
export const contentInput = z.enum(CONTENT_LEVELS);

/** A sample ratio. */
export const sampleRatioInput = z.coerce.number().min(0).max(1);

/** Extra resource attributes: string values only. */
export const resourceAttributesInput = z
  .record(
    z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((k) => !k.startsWith("hypotenuse."), "hypotenuse.* is ours"),
    z.string().max(1024),
  )
  .refine((r) => Object.keys(r).length <= 32, "at most 32 attributes");

/** A boolean from a form or the CLI. */
export const flagInput = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true");

/**
 * An exporter as every API answers it. Header values are not in it, and
 * neither is any field one would fit in.
 * @param row - The row.
 * @returns The public shape, epoch-ms timestamps.
 */
export function serializeTelemetryExporter(row: TelemetryExporter) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    endpoint: row.endpoint,
    protocol: row.protocol,
    headerNames: [...row.headerNames],
    signals: [...row.signals],
    content: row.content,
    agentNative: row.agentNative,
    traceSampleRatio: row.traceSampleRatio,
    resourceAttributes: { ...row.resourceAttributes },
    lastExportAt: row.lastExportAt?.getTime() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** {@link serializeTelemetryExporter}'s shape. */
export type SerializedTelemetryExporter = ReturnType<
  typeof serializeTelemetryExporter
>;

/**
 * Seal headers for the row.
 * @param headers - Name to value.
 * @returns The sealed column and the names, or nulls for none.
 */
export function sealHeaders(headers: Record<string, string>): {
  headersEncrypted: TelemetryExporter["headersEncrypted"];
  headerNames: string[];
} {
  const names = Object.keys(headers).sort();
  if (names.length === 0) return { headersEncrypted: null, headerNames: [] };
  return {
    headersEncrypted: encryptSecret(JSON.stringify(headers)),
    headerNames: names,
  };
}

/**
 * Open an exporter's headers, for the request to its collector only.
 * @param row - The row.
 * @returns Name to value.
 */
export function openHeaders(row: TelemetryExporter): Record<string, string> {
  if (!row.headersEncrypted) return {};
  return JSON.parse(decryptSecret(row.headersEncrypted)) as Record<
    string,
    string
  >;
}

/**
 * Check and normalize an endpoint, or refuse it as a validation error.
 * @param raw - The URL as typed.
 * @returns The normalized base URL.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export async function checkedEndpoint(raw: string): Promise<string> {
  const refusal = await endpointRefusal(raw);
  if (refusal) {
    throw new TypedError({
      message: refusal,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    });
  }
  return normalizeEndpoint(raw);
}

/**
 * One exporter of a project, locked, or a not-found refusal — the same for
 * one in another project as for none.
 * @param tx - The transaction (or the pool, for reads).
 * @param projectId - The project.
 * @param id - The exporter.
 * @param lock - Lock the row for update.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function exporterInProject(
  tx: TxHandle | typeof api.db.db,
  projectId: number,
  id: number,
  lock = true,
): Promise<TelemetryExporter> {
  const query = tx
    .select()
    .from(telemetryExporters)
    .where(
      and(
        eq(telemetryExporters.id, id),
        eq(telemetryExporters.projectId, projectId),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  if (!row) {
    throw new TypedError({
      message: "Telemetry exporter not found",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * Refuse a name another exporter of the project already has.
 * @param tx - The transaction.
 * @param projectId - The project.
 * @param name - The name.
 * @param exceptId - The exporter being renamed.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export async function assertNameFree(
  tx: TxHandle,
  projectId: number,
  name: string,
  exceptId?: number,
): Promise<void> {
  const [taken] = await tx
    .select({ id: telemetryExporters.id })
    .from(telemetryExporters)
    .where(
      and(
        eq(telemetryExporters.projectId, projectId),
        eq(telemetryExporters.name, name),
      ),
    );
  if (taken && taken.id !== exceptId) {
    throw new TypedError({
      message: `An exporter named "${name}" already exists in this project`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    });
  }
}
