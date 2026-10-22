import { loadFromEnvIfSet } from "keryx";

/**
 * Telemetry export: relaying a project's OTLP to the collectors its admins
 * configured (`telemetry_exporters`).
 *
 * - `allowPrivateEndpoints` — accept `http` and loopback, private,
 *   link-local, and metadata addresses as exporter endpoints. Off in a
 *   deployment, where the worker would otherwise POST into Render's own
 *   network at a tenant's say-so; on for development and tests, whose
 *   collectors are local.
 * - `lateWindowMs` — how long after a turn finishes `daemon:telemetry` still
 *   accepts its batches: the daemon's receiver drains and its queue flushes
 *   after `daemon:complete`, which never waits for telemetry.
 * - `projectBytesPerSecond` / `projectBurstBytes` — each project's ingress
 *   budget, a Redis token bucket over the bytes `daemon:telemetry` accepts.
 * - `streamMaxLength` / `streamTtlMs` — the per-project Redis stream batches
 *   wait in for export: at most this many entries, gone this long after the
 *   last one. Relayed, not stored.
 * - `exportFrequencyMs` — how often the `telemetry:export` clock drains the
 *   streams.
 * - `exportTimeoutMs` — one POST to a collector.
 * - `exportBatchEntries` — how many stream entries one POST may carry.
 */
export const configTelemetry = {
  allowPrivateEndpoints: await loadFromEnvIfSet(
    "TELEMETRY_ALLOW_PRIVATE_ENDPOINTS",
    false,
  ),
  lateWindowMs: await loadFromEnvIfSet("TELEMETRY_LATE_WINDOW", 5 * 60_000),
  projectBytesPerSecond: await loadFromEnvIfSet(
    "TELEMETRY_PROJECT_BYTES_PER_SECOND",
    1024 * 1024,
  ),
  projectBurstBytes: await loadFromEnvIfSet(
    "TELEMETRY_PROJECT_BURST_BYTES",
    16 * 1024 * 1024,
  ),
  streamMaxLength: await loadFromEnvIfSet(
    "TELEMETRY_STREAM_MAX_LENGTH",
    10_000,
  ),
  streamTtlMs: await loadFromEnvIfSet("TELEMETRY_STREAM_TTL_MS", 60 * 60_000),
  exportFrequencyMs: await loadFromEnvIfSet(
    "TELEMETRY_EXPORT_FREQUENCY_MS",
    2_000,
  ),
  exportTimeoutMs: await loadFromEnvIfSet(
    "TELEMETRY_EXPORT_TIMEOUT_MS",
    10_000,
  ),
  exportBatchEntries: await loadFromEnvIfSet(
    "TELEMETRY_EXPORT_BATCH_ENTRIES",
    200,
  ),
};

declare module "keryx" {
  interface KeryxConfig {
    telemetry: typeof configTelemetry;
  }
}
