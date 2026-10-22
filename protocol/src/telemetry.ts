/**
 * Telemetry export, as the server and the daemon both see it: content levels
 * and how a batch is filtered down to one, the W3C `traceparent` a turn's
 * trace is joined by, the sampling number every decision shares, redaction,
 * and the wire shapes of the claim's `telemetry` and the runner's cap.
 */
import { z } from "zod";
import type {
  AnyValue,
  KeyValue,
  LogsRequest,
  MetricsRequest,
  OtlpRequestBySignal,
  OtlpSignal,
  TracesRequest,
} from "./otlp";

/** How much of what is observed an exporter receives, least first. */
export const CONTENT_LEVELS = ["metadata", "content", "full"] as const;

/** One of {@link CONTENT_LEVELS}. */
export const ContentLevel = z.enum(CONTENT_LEVELS);
export type ContentLevel = z.infer<typeof ContentLevel>;

/**
 * A level's rank, for comparing.
 * @param level - The level.
 * @returns 0, 1, or 2.
 */
export function levelRank(level: ContentLevel): number {
  return CONTENT_LEVELS.indexOf(level);
}

/**
 * The lower of two levels.
 * @param a - One.
 * @param b - The other.
 * @returns The lower.
 */
export function minLevel(a: ContentLevel, b: ContentLevel): ContentLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/**
 * The highest of some levels.
 * @param levels - The levels.
 * @returns The highest, or `metadata` for none.
 */
export function maxLevel(levels: Iterable<ContentLevel>): ContentLevel {
  let best: ContentLevel = "metadata";
  for (const l of levels) if (levelRank(l) > levelRank(best)) best = l;
  return best;
}

/**
 * The attribute that says the least level a whole record needs — a log record
 * or a span that is content through and through (an ACP frame, a stderr line,
 * a native agent span collected while prompts were logged). Absent means
 * `metadata`.
 */
export const LEVEL_ATTRIBUTE = "hypotenuse.telemetry.level";

/**
 * Attributes under this prefix are free text — from the agent, the person, or
 * the repository — and reach only exporters at `content` or above. Everything
 * else on a record is metadata.
 */
export const CONTENT_ATTRIBUTE_PREFIX = "hypotenuse.content.";

/** The most of one attribute or log body kept, in bytes. */
export const CONTENT_CAP_BYTES = 64 * 1024;

/** Set beside a content attribute the cap cut: the original size. */
export const TRUNCATED_SUFFIX = ".original_bytes";

/** The daemon's work item header on `daemon:telemetry`. */
export const TELEMETRY_WORK_ITEM_HEADER = "X-Hypotenuse-Work-Item";

/** The signal header on `daemon:telemetry`. */
export const TELEMETRY_SIGNAL_HEADER = "X-Hypotenuse-Signal";

/** The W3C trace context header. */
export const TRACEPARENT_HEADER = "traceparent";

/** `daemon:telemetry`'s `error.type` for a batch after the late window (410). */
export const TELEMETRY_LATE = "TELEMETRY_LATE";

/** `daemon:telemetry`'s `error.type` for a turn nobody exports (409). */
export const TELEMETRY_NOT_WANTED = "TELEMETRY_NOT_WANTED";

/** `daemon:telemetry`'s `error.type` when the project's byte rate is spent (429). */
export const TELEMETRY_RATE_LIMITED = "TELEMETRY_RATE_LIMITED";

/** The largest `daemon:telemetry` body, compressed or not. */
export const MAX_TELEMETRY_BODY_BYTES = 1024 * 1024;

/** The largest `daemon:telemetry` body once gunzipped. */
export const MAX_TELEMETRY_INFLATED_BYTES = 8 * 1024 * 1024;

/**
 * What the claim tells the daemon about a turn's telemetry. Null when no
 * exporter wants it, or this runner sends none.
 */
export const ClaimTelemetry = z.looseObject({
  traceparent: z
    .string()
    .describe("The turn's root span; every daemon:* call for it carries it"),
  sampled: z
    .boolean()
    .describe("Whether any exporter keeps this turn's spans and logs"),
  content: ContentLevel.describe(
    "The level to collect at, already lowered to this runner's cap",
  ),
  agentNative: z
    .boolean()
    .describe("Whether to capture the coding agent's own telemetry"),
});
export type ClaimTelemetry = z.infer<typeof ClaimTelemetry>;

/** The runner owner's cap, reported in capabilities. */
export const TelemetryCapability = z.strictObject({
  enabled: z.boolean(),
  maxContent: ContentLevel,
  agentNative: z.boolean(),
});
export type TelemetryCapability = z.infer<typeof TelemetryCapability>;

/** `daemon:telemetry`'s answer. */
export const TelemetryResponse = z.looseObject({
  accepted: z.boolean(),
});
export type TelemetryResponse = z.infer<typeof TelemetryResponse>;

/** A parsed `traceparent`. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/**
 * Random bytes as hex.
 * @param bytes - How many.
 * @returns Lowercase hex, never all zeros.
 */
function randomHex(bytes: number): string {
  for (;;) {
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    if (buf.some((b) => b !== 0)) return Buffer.from(buf).toString("hex");
  }
}

/** @returns A new 16-byte trace id, hex. */
export function newTraceId(): string {
  return randomHex(16);
}

/** @returns A new 8-byte span id, hex. */
export function newSpanId(): string {
  return randomHex(8);
}

/**
 * Write a `traceparent`.
 * @param ctx - The trace, the parent span, and the sampled flag.
 * @returns `00-<trace>-<span>-<flags>`.
 */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/**
 * Read a `traceparent`.
 * @param value - The header, possibly absent.
 * @returns The context, or null when it is not a valid version-00 one.
 */
export function parseTraceparent(
  value: string | null | undefined,
): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    (value ?? "").trim().toLowerCase(),
  );
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/**
 * The number every sampling decision about a trace uses: its last 13 hex
 * digits as a fraction of [0, 1). An exporter keeps the trace when this is
 * below its ratio, so a lower ratio keeps a subset of what a higher one does.
 * @param traceId - The trace id, hex.
 * @returns A number in [0, 1).
 */
export function sampleNumber(traceId: string): number {
  return Number.parseInt(traceId.slice(-13), 16) / 2 ** 52;
}

/**
 * Whether a ratio keeps a trace.
 * @param traceId - The trace.
 * @param ratio - 0 to 1.
 * @returns True when kept.
 */
export function sampledBy(traceId: string, ratio: number): boolean {
  return ratio >= 1 || sampleNumber(traceId) < ratio;
}

/**
 * Cut a free-text value at {@link CONTENT_CAP_BYTES}.
 * @param text - The text.
 * @returns The kept text and, when cut, the original size in bytes.
 */
export function capContent(text: string): {
  text: string;
  originalBytes: number | null;
} {
  const bytes = Buffer.byteLength(text);
  if (bytes <= CONTENT_CAP_BYTES) return { text, originalBytes: null };
  let cut = Buffer.from(text).subarray(0, CONTENT_CAP_BYTES).toString("utf8");
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, originalBytes: bytes };
}

/**
 * A record's level, from its attributes.
 * @param attrs - The attributes.
 * @returns The level it needs.
 */
export function recordLevel(attrs: KeyValue[] | undefined): ContentLevel {
  const found = attrs?.find((a) => a.key === LEVEL_ATTRIBUTE)?.value
    ?.stringValue as ContentLevel | undefined;
  return found && (CONTENT_LEVELS as readonly string[]).includes(found)
    ? found
    : "metadata";
}

/**
 * Drop the content attributes below `content`.
 * @param attrs - The attributes.
 * @param level - The exporter's level.
 * @returns The attributes it may receive.
 */
function filterAttributes(
  attrs: KeyValue[] | undefined,
  level: ContentLevel,
): KeyValue[] | undefined {
  if (!attrs || levelRank(level) >= levelRank("content")) return attrs;
  return attrs.filter((a) => !a.key.startsWith(CONTENT_ATTRIBUTE_PREFIX));
}

/**
 * Filter a request down to what an exporter at `level` receives: a record
 * that needs more is dropped whole, and below `content` every content
 * attribute goes. Returns a new request; empty groups are removed.
 * @param signal - The signal.
 * @param request - The request.
 * @param level - The exporter's level.
 * @returns The filtered request.
 */
export function filterForLevel<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
  level: ContentLevel,
): OtlpRequestBySignal[S] {
  const allowed = (attrs: KeyValue[] | undefined) =>
    levelRank(recordLevel(attrs)) <= levelRank(level);
  if (signal === "traces") {
    const r = request as TracesRequest;
    return {
      resourceSpans: (r.resourceSpans ?? [])
        .map((rs) => ({
          ...rs,
          scopeSpans: (rs.scopeSpans ?? [])
            .map((ss) => ({
              ...ss,
              spans: (ss.spans ?? [])
                .filter((s) => allowed(s.attributes))
                .map((s) => ({
                  ...s,
                  attributes: filterAttributes(s.attributes, level),
                  events: s.events
                    ?.filter((e) => allowed(e.attributes))
                    .map((e) => ({
                      ...e,
                      attributes: filterAttributes(e.attributes, level),
                    })),
                })),
            }))
            .filter((ss) => ss.spans.length > 0),
        }))
        .filter((rs) => rs.scopeSpans.length > 0),
    } as OtlpRequestBySignal[S];
  }
  if (signal === "logs") {
    const r = request as LogsRequest;
    return {
      resourceLogs: (r.resourceLogs ?? [])
        .map((rl) => ({
          ...rl,
          scopeLogs: (rl.scopeLogs ?? [])
            .map((sl) => ({
              ...sl,
              logRecords: (sl.logRecords ?? [])
                .filter((l) => allowed(l.attributes))
                .map((l) => ({
                  ...l,
                  attributes: filterAttributes(l.attributes, level),
                })),
            }))
            .filter((sl) => sl.logRecords.length > 0),
        }))
        .filter((rl) => rl.scopeLogs.length > 0),
    } as OtlpRequestBySignal[S];
  }
  // Metrics carry no free text: names, numbers, and metadata attributes.
  return request;
}

/**
 * How many records a request holds.
 * @param signal - The signal.
 * @param request - The request.
 * @returns Spans, log records, or metrics.
 */
export function recordCount<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
): number {
  if (signal === "traces")
    return ((request as TracesRequest).resourceSpans ?? []).reduce(
      (n, rs) =>
        n +
        (rs.scopeSpans ?? []).reduce((m, s) => m + (s.spans?.length ?? 0), 0),
      0,
    );
  if (signal === "logs")
    return ((request as LogsRequest).resourceLogs ?? []).reduce(
      (n, rl) =>
        n +
        (rl.scopeLogs ?? []).reduce(
          (m, s) => m + (s.logRecords?.length ?? 0),
          0,
        ),
      0,
    );
  return ((request as MetricsRequest).resourceMetrics ?? []).reduce(
    (n, rm) =>
      n +
      (rm.scopeMetrics ?? []).reduce((m, s) => m + (s.metrics?.length ?? 0), 0),
    0,
  );
}

/**
 * The trace ids a request's spans and logs belong to.
 * @param signal - The signal.
 * @param request - The request.
 * @returns The distinct ids.
 */
export function traceIdsOf<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
): Set<string> {
  const ids = new Set<string>();
  if (signal === "traces") {
    for (const rs of (request as TracesRequest).resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? []) if (s.traceId) ids.add(s.traceId);
  } else if (signal === "logs") {
    for (const rl of (request as LogsRequest).resourceLogs ?? [])
      for (const sl of rl.scopeLogs ?? [])
        for (const l of sl.logRecords ?? []) if (l.traceId) ids.add(l.traceId);
  }
  return ids;
}

/**
 * Common secret shapes, redacted wherever they appear in a string. Best
 * effort: a secret that looks like nothing in particular is caught only by
 * value.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // Hypotenuse's own tokens.
  /hyp_(?:rt|cli)_[A-Za-z0-9_-]{8,}/g,
  // Model and SaaS provider keys.
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /lin_(?:api|oauth)_[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // JWTs.
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A bearer credential in a header written out.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/** What a redacted secret is replaced with. */
export const REDACTED = "[REDACTED]";

/**
 * Attribute keys whose value is a credential whatever it looks like:
 * `authorization`, `cookie`, `token`, `secret`, and `password`, alone or
 * after a `.`, `_`, or `-`, and any `…-key` / `…_key` / `…-token` /
 * `…_token` (`x-api-key`, `access_token`). A dotted `….key` is not one:
 * `linear.team.key` is a team key, `ENG`.
 */
const SECRET_KEY =
  /((^|[._-])(authorization|cookie|set-cookie|token|secret|password|passwd)$)|([a-z0-9][_-](key|token)$)/i;

/** What a redaction pass knows. */
export interface RedactOptions {
  /** Secret values, redacted wherever they appear (empty and short ones are skipped). */
  values?: Iterable<string>;
  /** Attribute keys redacted by name, compared exactly. */
  keys?: Iterable<string>;
}

/** Values shorter than this are not redacted by value: too many false hits. */
const MIN_SECRET_LENGTH = 6;

/**
 * Redact a string.
 * @param text - The text.
 * @param values - Secret values, longest first.
 * @returns The text with every secret replaced.
 */
function redactText(text: string, values: string[]): string {
  let out = text;
  for (const v of values)
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/**
 * Redact everything in an OTLP request: every string anywhere in it (bodies,
 * attribute values, names) by value and by pattern, and every attribute whose
 * key names a credential. Returns a new request.
 * @param request - Any signal's request.
 * @param options - The values and keys to redact.
 * @returns The redacted request.
 */
export function redactOtlp<T>(request: T, options: RedactOptions = {}): T {
  const values = [...new Set(options.values ?? [])]
    .filter((v) => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  const keys = new Set(options.keys ?? []);
  const isSecretKey = (k: string) => keys.has(k) || SECRET_KEY.test(k);
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === "string") {
      // Ids are hex; leave them, they are what joins the trace.
      if (key === "traceId" || key === "spanId" || key === "parentSpanId")
        return value;
      return redactText(value, values);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // An attribute whose key names a credential loses its value whole.
      if (typeof obj.key === "string" && "value" in obj && isSecretKey(obj.key))
        return { key: obj.key, value: { stringValue: REDACTED } };
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  return walk(request, "") as T;
}

/**
 * Merge resource attributes into a request's every resource, the given ones
 * winning.
 * @param signal - The signal.
 * @param request - The request (modified in place).
 * @param attrs - The attributes to stamp.
 * @returns The request.
 */
export function stampResource<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
  attrs: KeyValue[],
): OtlpRequestBySignal[S] {
  const groups =
    signal === "traces"
      ? (request as TracesRequest).resourceSpans
      : signal === "logs"
        ? (request as LogsRequest).resourceLogs
        : (request as MetricsRequest).resourceMetrics;
  const keys = new Set(attrs.map((a) => a.key));
  for (const group of groups ?? []) {
    const existing = (group.resource?.attributes ?? []).filter(
      (a) => !keys.has(a.key),
    );
    group.resource = { ...group.resource, attributes: [...existing, ...attrs] };
  }
  return request;
}

/**
 * Join requests of one signal into one.
 * @param signal - The signal.
 * @param requests - The requests.
 * @returns One request holding every group.
 */
export function mergeRequests<S extends OtlpSignal>(
  signal: S,
  requests: OtlpRequestBySignal[S][],
): OtlpRequestBySignal[S] {
  if (signal === "traces")
    return {
      resourceSpans: requests.flatMap(
        (r) => (r as TracesRequest).resourceSpans ?? [],
      ),
    } as OtlpRequestBySignal[S];
  if (signal === "logs")
    return {
      resourceLogs: requests.flatMap(
        (r) => (r as LogsRequest).resourceLogs ?? [],
      ),
    } as OtlpRequestBySignal[S];
  return {
    resourceMetrics: requests.flatMap(
      (r) => (r as MetricsRequest).resourceMetrics ?? [],
    ),
  } as OtlpRequestBySignal[S];
}

/**
 * Whether an attribute value is a non-empty string.
 * @param value - The value.
 * @returns The string, or null.
 */
export function stringOf(value: AnyValue | undefined): string | null {
  return typeof value?.stringValue === "string" ? value.stringValue : null;
}
