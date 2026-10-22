import { type Action, config } from "keryx";
import { z } from "zod";
import { exportAll } from "../../ops/TelemetryRelayOps";

/**
 * `telemetry:export` — the relay's clock: flush the server's own metrics,
 * then drain every project's telemetry stream to each of its enabled
 * exporters, each through its own consumer group, with retry and backoff
 * (`ops/TelemetryRelayOps.ts`).
 *
 * Task-only, never MCP. Its writes — an exporter's `lastExportAt` and
 * `lastError` — are a clock's, unaudited like every clock's.
 */
export class TelemetryExport implements Action {
  name = "telemetry:export";
  description =
    "Export queued telemetry to each project's OpenTelemetry collectors. Runs automatically; not exposed over HTTP.";
  mcp = { tool: false };
  task = { queue: "default", frequency: config.telemetry.exportFrequencyMs };
  inputs = z.object({});

  /**
   * @returns Per exporter: entries sent and dropped, and those backing off.
   */
  async run() {
    return exportAll();
  }
}
