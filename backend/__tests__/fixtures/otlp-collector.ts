import { gunzipSync } from "node:zlib";
import {
  decodeOtlpBody,
  type LogsRequest,
  type MetricsRequest,
  type OtlpLogRecord,
  type OtlpMetric,
  type OtlpRequestBySignal,
  type OtlpSignal,
  type OtlpSpan,
  plainValue,
  signalOfPath,
  type TracesRequest,
} from "@hypotenuse/protocol";

/**
 * A small OpenTelemetry collector for tests: an OTLP/HTTP receiver that
 * records every request — its path, headers, raw bytes, and the request
 * decoded from protobuf or JSON, gzipped or not — and can answer `429` or
 * `503` on demand. Like finear, it is not a mock of our code: it speaks the
 * wire protocol to the relay, and the relay cannot tell it from a vendor's.
 */

/** One request the collector received. */
export interface CollectorRequest {
  path: string;
  signal: OtlpSignal;
  headers: Record<string, string>;
  contentType: string;
  /** The body as it arrived (possibly gzipped). */
  raw: Uint8Array;
  /** The body gunzipped. */
  body: Uint8Array;
  decoded: OtlpRequestBySignal[OtlpSignal];
  at: number;
}

/** A span with its resource attributes, flattened for assertions. */
export interface ReceivedSpan extends OtlpSpan {
  resource: Record<string, unknown>;
  attrs: Record<string, unknown>;
  /** Which exporter path prefix received it (one collector can serve several). */
  prefix: string;
}

/** A log record with its resource, flattened. */
export interface ReceivedLog extends OtlpLogRecord {
  resource: Record<string, unknown>;
  attrs: Record<string, unknown>;
  prefix: string;
}

/** A metric with its resource, flattened. */
export interface ReceivedMetric extends OtlpMetric {
  resource: Record<string, unknown>;
  prefix: string;
}

/**
 * Attributes as a plain object.
 * @param attrs - OTLP attributes.
 * @returns Key to value.
 */
export function flat(
  attrs: { key: string; value?: unknown }[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    (attrs ?? []).map((a) => [a.key, plainValue(a.value as never)]),
  );
}

/** The collector. */
export class OtlpCollector {
  readonly requests: CollectorRequest[] = [];
  private failures: { status: number; retryAfter?: string }[] = [];
  private failAll: { status: number } | null = null;
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
  }

  /** The collector's base URL. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * Answer the next requests with failures.
   * @param status - The status, e.g. 429 or 503.
   * @param times - How many requests.
   * @param retryAfter - A `Retry-After` value.
   */
  fail(status: number, times = 1, retryAfter?: string): void {
    for (let i = 0; i < times; i++) this.failures.push({ status, retryAfter });
  }

  /**
   * Answer every request with a status until {@link recover}.
   * @param status - The status.
   */
  failEverything(status: number): void {
    this.failAll = { status };
  }

  /** Stop failing. */
  recover(): void {
    this.failAll = null;
    this.failures = [];
  }

  /** Forget everything received. */
  reset(): void {
    this.requests.length = 0;
    this.recover();
  }

  /** Stop the server. */
  stop(): void {
    this.server.stop(true);
  }

  /**
   * Handle one request.
   * @param req - The request.
   * @returns The answer.
   */
  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const signal = signalOfPath(path);
    if (req.method !== "POST" || !signal)
      return new Response("not found", { status: 404 });
    const failure = this.failAll ?? this.failures.shift();
    if (failure) {
      return new Response("unavailable", {
        status: failure.status,
        headers:
          "retryAfter" in failure && typeof failure.retryAfter === "string"
            ? { "Retry-After": failure.retryAfter }
            : undefined,
      });
    }
    const raw = new Uint8Array(await req.arrayBuffer());
    const gz = (req.headers.get("content-encoding") ?? "").includes("gzip");
    const body = gz ? new Uint8Array(gunzipSync(raw)) : raw;
    const contentType = req.headers.get("content-type") ?? "";
    let decoded: OtlpRequestBySignal[OtlpSignal];
    try {
      decoded = decodeOtlpBody(signal, body, contentType);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    this.requests.push({
      path,
      signal,
      headers: Object.fromEntries(req.headers.entries()),
      contentType,
      raw,
      body,
      decoded,
      at: Date.now(),
    });
    return Response.json({});
  }

  /**
   * The requests whose path starts with a prefix.
   * @param prefix - A path prefix ("" for all).
   * @returns The requests.
   */
  private under(prefix: string): CollectorRequest[] {
    return this.requests.filter((r) => r.path.startsWith(prefix));
  }

  /**
   * Every span received under a path prefix.
   * @param prefix - The prefix one exporter's endpoint has.
   * @returns The spans.
   */
  spans(prefix = ""): ReceivedSpan[] {
    return this.under(prefix)
      .filter((r) => r.signal === "traces")
      .flatMap((r) =>
        ((r.decoded as TracesRequest).resourceSpans ?? []).flatMap((rs) =>
          (rs.scopeSpans ?? []).flatMap((ss) =>
            (ss.spans ?? []).map((s) => ({
              ...s,
              resource: flat(rs.resource?.attributes),
              attrs: flat(s.attributes),
              prefix: r.path.replace(/\/v1\/traces$/, ""),
            })),
          ),
        ),
      );
  }

  /**
   * Every log record received under a path prefix.
   * @param prefix - The prefix.
   * @returns The records.
   */
  logs(prefix = ""): ReceivedLog[] {
    return this.under(prefix)
      .filter((r) => r.signal === "logs")
      .flatMap((r) =>
        ((r.decoded as LogsRequest).resourceLogs ?? []).flatMap((rl) =>
          (rl.scopeLogs ?? []).flatMap((sl) =>
            (sl.logRecords ?? []).map((l) => ({
              ...l,
              resource: flat(rl.resource?.attributes),
              attrs: flat(l.attributes),
              prefix: r.path.replace(/\/v1\/logs$/, ""),
            })),
          ),
        ),
      );
  }

  /**
   * Every metric received under a path prefix.
   * @param prefix - The prefix.
   * @returns The metrics.
   */
  metrics(prefix = ""): ReceivedMetric[] {
    return this.under(prefix)
      .filter((r) => r.signal === "metrics")
      .flatMap((r) =>
        ((r.decoded as MetricsRequest).resourceMetrics ?? []).flatMap((rm) =>
          (rm.scopeMetrics ?? []).flatMap((sm) =>
            (sm.metrics ?? []).map((m) => ({
              ...m,
              resource: flat(rm.resource?.attributes),
              prefix: r.path.replace(/\/v1\/metrics$/, ""),
            })),
          ),
        ),
      );
  }

  /**
   * Everything received, as text: every raw body, every inflated body, and
   * every decoded request re-serialized — what a secret must not appear in.
   * @returns The text.
   */
  everything(): string {
    return this.requests
      .map(
        (r) =>
          `${new TextDecoder().decode(r.raw)}\n${new TextDecoder().decode(r.body)}\n${JSON.stringify(r.decoded)}`,
      )
      .join("\n");
  }
}
