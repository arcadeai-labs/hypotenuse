/**
 * A turn's loopback OTLP/HTTP receiver: where the coding agent's own
 * OpenTelemetry is pointed (`native.ts`), so model requests, token counts,
 * and cost join the turn's trace.
 *
 * - Bound to `127.0.0.1` on an ephemeral port, under a random path prefix:
 *   the base URL is `http://127.0.0.1:<port>/<nonce>`, and nothing else on
 *   the machine can guess it — an agent that cannot send headers still works.
 * - Accepts `application/x-protobuf` and `application/json`, gzip or not.
 * - Stamps every batch with the turn's resource attributes and
 *   `hypotenuse.source = agent_native`, moves spans and logs of the agent's
 *   own trace into the turn's (an agent that honoured `TRACEPARENT` is there
 *   already) with its root spans under `daemon.turn`, tags every record with
 *   the level the turn collected at — what the agent logs depends on what it
 *   was asked to, so a lower-level exporter does not receive it — and queues
 *   it, redacted, for the relay.
 * - Closed when the turn ends, after a short drain so the agent's last flush
 *   lands.
 */
import {
  attributes,
  decodeOtlpBody,
  type KeyValue,
  LEVEL_ATTRIBUTE,
  type LogsRequest,
  type MetricsRequest,
  type OtlpRequestBySignal,
  type OtlpSignal,
  signalOfPath,
  stampResource,
  type TracesRequest,
} from "../../../protocol/src/index";
import type { TurnTelemetry } from "./collector";

/** The largest body the receiver takes. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** How long the receiver waits for an agent's last flush. */
export const DRAIN_MS = 1_500;

/** One turn's receiver. */
export class NativeReceiver {
  /** The random path prefix; a secret, redacted wherever it appears. */
  readonly nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(18)),
  ).toString("base64url");
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** Batches received, by signal (for `status` and tests). */
  readonly received: Record<OtlpSignal, number> = {
    traces: 0,
    metrics: 0,
    logs: 0,
  };
  private lastReceivedAt = 0;

  /**
   * @param turn - The turn whose trace the agent's telemetry joins.
   */
  constructor(private readonly turn: TurnTelemetry) {}

  /**
   * Start listening.
   * @returns The base URL to point the agent at.
   */
  start(): string {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch: (req) => this.handle(req),
    });
    return this.endpoint;
  }

  /** `http://127.0.0.1:<port>/<nonce>`. */
  get endpoint(): string {
    return `http://127.0.0.1:${this.server?.port ?? 0}/${this.nonce}`;
  }

  /**
   * Handle one export.
   * @param req - The request.
   * @returns OTLP's success, an empty message in the request's encoding.
   */
  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const prefix = `/${this.nonce}/`;
    const signal = signalOfPath(url.pathname);
    if (req.method !== "POST" || !url.pathname.startsWith(prefix) || !signal)
      return new Response(null, { status: 404 });
    const contentType = req.headers.get("content-type");
    try {
      let bytes = new Uint8Array(await req.arrayBuffer());
      if ((req.headers.get("content-encoding") ?? "").includes("gzip"))
        bytes = new Uint8Array(Bun.gunzipSync(bytes));
      if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("too large");
      this.accept(signal, decodeOtlpBody(signal, bytes, contentType));
    } catch {
      return new Response(null, { status: 400 });
    }
    const json = (contentType ?? "").includes("json");
    return new Response(json ? "{}" : new Uint8Array(0), {
      status: 200,
      headers: {
        "Content-Type": json ? "application/json" : "application/x-protobuf",
      },
    });
  }

  /**
   * Join a batch to the turn and queue it.
   * @param signal - The signal.
   * @param request - The batch.
   */
  accept<S extends OtlpSignal>(
    signal: S,
    request: OtlpRequestBySignal[S],
  ): void {
    this.received[signal]++;
    this.lastReceivedAt = Date.now();
    const turn = this.turn;
    const level: KeyValue = {
      key: LEVEL_ATTRIBUTE,
      value: { stringValue: turn.level },
    };
    const tag = (attrs: KeyValue[] | undefined) => [
      ...(attrs ?? []).filter((a) => a.key !== LEVEL_ATTRIBUTE),
      level,
    ];
    if (signal === "traces") {
      if (!turn.sampled) return;
      for (const rs of (request as TracesRequest).resourceSpans ?? [])
        for (const ss of rs.scopeSpans ?? []) {
          // An agent's own trace is moved into the turn's; its roots go
          // under `daemon.turn`, and everything else keeps its parent.
          ss.spans = (ss.spans ?? []).map((s) => {
            const root = !s.parentSpanId;
            return {
              ...s,
              traceId: turn.traceId,
              ...(root ? { parentSpanId: turn.turnSpan.spanId } : {}),
              attributes: tag(s.attributes),
            };
          });
        }
    } else if (signal === "logs") {
      if (!turn.sampled) return;
      for (const rl of (request as LogsRequest).resourceLogs ?? [])
        for (const sl of rl.scopeLogs ?? [])
          sl.logRecords = (sl.logRecords ?? []).map((l) => ({
            ...l,
            traceId: turn.traceId,
            ...(l.traceId && l.traceId !== turn.traceId
              ? { spanId: turn.turnSpan.spanId }
              : {}),
            attributes: tag(l.attributes),
          }));
    } else {
      // Metrics carry no trace; they are stamped like everything else.
      void (request as MetricsRequest);
    }
    // The agent's own `service.*` stays: it says which agent produced it.
    stampResource(signal, request, [
      ...turn.resourceAttributes.filter(
        (a) => a.key !== "hypotenuse.source" && !a.key.startsWith("service."),
      ),
      ...attributes({ "hypotenuse.source": "agent_native" }),
    ]);
    turn.enqueue(signal, request);
  }

  /**
   * Stop, after giving the agent a moment for its last flush — or at once if
   * nothing arrived lately.
   * @param drainMs - The most to wait.
   */
  async close(drainMs = DRAIN_MS): Promise<void> {
    if (!this.server) return;
    const quietFor = Date.now() - this.lastReceivedAt;
    if (quietFor < drainMs) await Bun.sleep(drainMs - quietFor);
    this.server.stop(true);
    this.server = null;
  }
}
