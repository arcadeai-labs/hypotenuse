import type {
  ContentLevel,
  OtlpProtocol,
  OtlpSignal,
} from "@hypotenuse/protocol";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { EncryptedSecret } from "../ops/CryptoOps";
import { projects } from "./projects";

/**
 * A `telemetry_exporter` is one OpenTelemetry collector a project's work is
 * exported to over OTLP/HTTP. A project may have several (a vendor and a
 * self-hosted collector are a common pair); each gets its own share of the
 * project's traces (`traceSampleRatio`), its own signals, and its own content
 * level, and the worker filters every batch down to that level before
 * sending it.
 *
 * Its headers are a credential (a vendor API key, usually): sealed with
 * `CryptoOps` like the Linear tokens, never serialized, and never sent to a
 * runner — the server relays, so the daemon never learns an endpoint or a
 * header. `headerNames` is kept in the clear so the dashboard can show which
 * headers are set without decrypting them.
 *
 * Hypotenuse relays and stores nothing: beyond this row, telemetry lives in a
 * Redis stream for at most an hour (`ops/TelemetryRelayOps.ts`).
 */
export const telemetryExporters = pgTable(
  "telemetry_exporters",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** OTLP/HTTP base URL; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended. */
    endpoint: text("endpoint").notNull(),
    protocol: text("protocol")
      .$type<OtlpProtocol>()
      .notNull()
      .default("http/protobuf"),
    /** A sealed JSON object of header name to value; null for none. */
    headersEncrypted: jsonb(
      "headers_encrypted",
    ).$type<EncryptedSecret | null>(),
    /** The header names, in the clear. */
    headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
    signals: jsonb("signals")
      .$type<OtlpSignal[]>()
      .notNull()
      .default(["traces", "metrics", "logs"]),
    content: text("content")
      .$type<ContentLevel>()
      .notNull()
      .default("metadata"),
    /** Capture the coding agent's own telemetry on runners that allow it. */
    agentNative: boolean("agent_native").notNull().default(true),
    /** 0–1: the share of turns this exporter keeps, decided per trace id. */
    traceSampleRatio: real("trace_sample_ratio").notNull().default(1),
    /** Extra resource attributes stamped on everything sent here. */
    resourceAttributes: jsonb("resource_attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    lastExportAt: timestamp("last_export_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    projectIndex: index("telemetry_exporters_project_idx").on(t.projectId),
    nameUnique: uniqueIndex("telemetry_exporters_project_name_idx").on(
      t.projectId,
      t.name,
    ),
  }),
);

export type TelemetryExporter = typeof telemetryExporters.$inferSelect;
export type NewTelemetryExporter = typeof telemetryExporters.$inferInsert;
