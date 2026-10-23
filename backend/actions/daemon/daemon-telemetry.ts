import { type Action, type Connection, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import { rawRequestOf } from "../../ops/RawRequestOps";
import { acceptDaemonTelemetry } from "../../ops/TelemetryRelayOps";

/**
 * `daemon:telemetry` — `POST /api/daemon/telemetry`, where a daemon relays
 * one OTLP batch of one turn: the daemon's own spans and logs, every ACP
 * frame at `full`, and the coding agent's native telemetry its loopback
 * receiver captured. The body is an OTLP/HTTP request (JSON or protobuf,
 * gzip or not) with `X-Hypotenuse-Signal`, `X-Hypotenuse-Work-Item`, and the
 * turn's `traceparent`; the checks are `acceptDaemonTelemetry`'s. Accepted
 * until `TELEMETRY_LATE_WINDOW` after the turn finishes, answered 202, and
 * exported later by `telemetry:export` — the daemon never learns where.
 *
 * Machine traffic: not audited (it writes nothing to Postgres), never MCP,
 * never wrapped by the CLI.
 */
export class DaemonTelemetry implements Action {
  name = "daemon:telemetry";
  description =
    "Called by a runner's daemon to relay one OTLP batch of a turn it holds to the project's telemetry exporters. Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("request")];
  web = {
    route: "/daemon/telemetry",
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  inputs = z.object({});

  /**
   * @param _params - Nothing: the body is read raw.
   * @param connection - The runner's connection (resolved by the principal hook).
   * @returns The raw answer.
   */
  async run(
    _params: unknown,
    connection: Connection<SessionImpl, PrincipalMeta>,
  ): Promise<Response> {
    const answer = await acceptDaemonTelemetry(
      connection.metadata.runner!,
      rawRequestOf(connection),
    );
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json", ...answer.headers },
    });
  }
}
