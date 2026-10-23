/**
 * OTLP — OpenTelemetry's wire format — as Hypotenuse speaks it.
 *
 * Everything inside Hypotenuse holds telemetry as **OTLP/JSON**: the
 * `Export*ServiceRequest` messages in the proto3 JSON mapping OTLP/HTTP
 * defines (camelCase fields, trace and span ids as hex, 64-bit integers as
 * decimal strings). The daemon builds it, the server stores and filters it,
 * and either side converts to and from **OTLP/protobuf** only at an edge:
 * an agent that posts protobuf to the daemon's receiver, and an exporter
 * configured for `http/protobuf`.
 *
 * The protobuf schema is a protobufjs JSON descriptor of the messages
 * `opentelemetry-proto` defines for the three signals, written out here rather
 * than generated: it is small, it changes rarely, and a field this codec does
 * not know (an exponential histogram, a summary) is skipped on decode, as
 * protobuf skips any unknown field.
 */
import protobuf from "protobufjs/light.js";

/** The three OTLP signals. */
export const OTLP_SIGNALS = ["traces", "metrics", "logs"] as const;

/** One of {@link OTLP_SIGNALS}. */
export type OtlpSignal = (typeof OTLP_SIGNALS)[number];

/** An attribute value. */
export interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
}

/** A named attribute. */
export interface KeyValue {
  key: string;
  value?: AnyValue;
}

/** Who produced the telemetry. */
export interface OtlpResource {
  attributes?: KeyValue[];
  droppedAttributesCount?: number;
}

/** The library that produced it. */
export interface InstrumentationScope {
  name?: string;
  version?: string;
  attributes?: KeyValue[];
}

/** A point in time on a span. */
export interface SpanEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: KeyValue[];
}

/** A span. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  flags?: number;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  events?: SpanEvent[];
  links?: { traceId: string; spanId: string; attributes?: KeyValue[] }[];
  status?: { code?: number; message?: string };
}

/** `ExportTraceServiceRequest`. */
export interface TracesRequest {
  resourceSpans?: {
    resource?: OtlpResource;
    scopeSpans?: { scope?: InstrumentationScope; spans?: OtlpSpan[] }[];
  }[];
}

/** A log record. */
export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  flags?: number;
  traceId?: string;
  spanId?: string;
  eventName?: string;
}

/** `ExportLogsServiceRequest`. */
export interface LogsRequest {
  resourceLogs?: {
    resource?: OtlpResource;
    scopeLogs?: {
      scope?: InstrumentationScope;
      logRecords?: OtlpLogRecord[];
    }[];
  }[];
}

/** A gauge or sum data point. */
export interface NumberDataPoint {
  attributes?: KeyValue[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: string | number;
}

/** A histogram data point. */
export interface HistogramDataPoint {
  attributes?: KeyValue[];
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  count?: string | number;
  sum?: number;
  bucketCounts?: (string | number)[];
  explicitBounds?: number[];
  min?: number;
  max?: number;
}

/** A metric. */
export interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  gauge?: { dataPoints?: NumberDataPoint[] };
  sum?: {
    dataPoints?: NumberDataPoint[];
    aggregationTemporality?: number;
    isMonotonic?: boolean;
  };
  histogram?: {
    dataPoints?: HistogramDataPoint[];
    aggregationTemporality?: number;
  };
}

/** `ExportMetricsServiceRequest`. */
export interface MetricsRequest {
  resourceMetrics?: {
    resource?: OtlpResource;
    scopeMetrics?: { scope?: InstrumentationScope; metrics?: OtlpMetric[] }[];
  }[];
}

/** Any signal's request, by signal. */
export interface OtlpRequestBySignal {
  traces: TracesRequest;
  metrics: MetricsRequest;
  logs: LogsRequest;
}

/** `SpanKind`. */
export const SPAN_KIND = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} as const;

/** `StatusCode`. */
export const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

/** `AggregationTemporality`. */
export const TEMPORALITY = { delta: 1, cumulative: 2 } as const;

/** `SeverityNumber`, the ones Hypotenuse writes. */
export const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 } as const;

/** The content types OTLP/HTTP uses. */
export const OTLP_CONTENT_TYPES = {
  "http/protobuf": "application/x-protobuf",
  "http/json": "application/json",
} as const;

/** An OTLP/HTTP protocol. */
export type OtlpProtocol = keyof typeof OTLP_CONTENT_TYPES;

/** A repeated field. */
const rep = (type: string, id: number) => ({ rule: "repeated", type, id });

/** The descriptor: the OTLP messages, field for field, camelCase. */
const DESCRIPTOR = {
  nested: {
    AnyValue: {
      oneofs: {
        value: {
          oneof: [
            "stringValue",
            "boolValue",
            "intValue",
            "doubleValue",
            "arrayValue",
            "kvlistValue",
            "bytesValue",
          ],
        },
      },
      fields: {
        stringValue: { type: "string", id: 1 },
        boolValue: { type: "bool", id: 2 },
        intValue: { type: "int64", id: 3 },
        doubleValue: { type: "double", id: 4 },
        arrayValue: { type: "ArrayValue", id: 5 },
        kvlistValue: { type: "KeyValueList", id: 6 },
        bytesValue: { type: "bytes", id: 7 },
      },
    },
    ArrayValue: { fields: { values: rep("AnyValue", 1) } },
    KeyValueList: { fields: { values: rep("KeyValue", 1) } },
    KeyValue: {
      fields: {
        key: { type: "string", id: 1 },
        value: { type: "AnyValue", id: 2 },
      },
    },
    InstrumentationScope: {
      fields: {
        name: { type: "string", id: 1 },
        version: { type: "string", id: 2 },
        attributes: rep("KeyValue", 3),
        droppedAttributesCount: { type: "uint32", id: 4 },
      },
    },
    Resource: {
      fields: {
        attributes: rep("KeyValue", 1),
        droppedAttributesCount: { type: "uint32", id: 2 },
      },
    },
    ExportTraceServiceRequest: {
      fields: { resourceSpans: rep("ResourceSpans", 1) },
    },
    ResourceSpans: {
      fields: {
        resource: { type: "Resource", id: 1 },
        scopeSpans: rep("ScopeSpans", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    ScopeSpans: {
      fields: {
        scope: { type: "InstrumentationScope", id: 1 },
        spans: rep("Span", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    Span: {
      fields: {
        traceId: { type: "bytes", id: 1 },
        spanId: { type: "bytes", id: 2 },
        traceState: { type: "string", id: 3 },
        parentSpanId: { type: "bytes", id: 4 },
        flags: { type: "fixed32", id: 16 },
        name: { type: "string", id: 5 },
        kind: { type: "int32", id: 6 },
        startTimeUnixNano: { type: "fixed64", id: 7 },
        endTimeUnixNano: { type: "fixed64", id: 8 },
        attributes: rep("KeyValue", 9),
        droppedAttributesCount: { type: "uint32", id: 10 },
        events: rep("SpanEvent", 11),
        droppedEventsCount: { type: "uint32", id: 12 },
        links: rep("SpanLink", 13),
        droppedLinksCount: { type: "uint32", id: 14 },
        status: { type: "SpanStatus", id: 15 },
      },
    },
    SpanEvent: {
      fields: {
        timeUnixNano: { type: "fixed64", id: 1 },
        name: { type: "string", id: 2 },
        attributes: rep("KeyValue", 3),
        droppedAttributesCount: { type: "uint32", id: 4 },
      },
    },
    SpanLink: {
      fields: {
        traceId: { type: "bytes", id: 1 },
        spanId: { type: "bytes", id: 2 },
        traceState: { type: "string", id: 3 },
        attributes: rep("KeyValue", 4),
        droppedAttributesCount: { type: "uint32", id: 5 },
        flags: { type: "fixed32", id: 6 },
      },
    },
    SpanStatus: {
      fields: {
        message: { type: "string", id: 2 },
        code: { type: "int32", id: 3 },
      },
    },
    ExportLogsServiceRequest: {
      fields: { resourceLogs: rep("ResourceLogs", 1) },
    },
    ResourceLogs: {
      fields: {
        resource: { type: "Resource", id: 1 },
        scopeLogs: rep("ScopeLogs", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    ScopeLogs: {
      fields: {
        scope: { type: "InstrumentationScope", id: 1 },
        logRecords: rep("LogRecord", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    LogRecord: {
      fields: {
        timeUnixNano: { type: "fixed64", id: 1 },
        observedTimeUnixNano: { type: "fixed64", id: 11 },
        severityNumber: { type: "int32", id: 2 },
        severityText: { type: "string", id: 3 },
        body: { type: "AnyValue", id: 5 },
        attributes: rep("KeyValue", 6),
        droppedAttributesCount: { type: "uint32", id: 7 },
        flags: { type: "fixed32", id: 8 },
        traceId: { type: "bytes", id: 9 },
        spanId: { type: "bytes", id: 10 },
        eventName: { type: "string", id: 12 },
      },
    },
    ExportMetricsServiceRequest: {
      fields: { resourceMetrics: rep("ResourceMetrics", 1) },
    },
    ResourceMetrics: {
      fields: {
        resource: { type: "Resource", id: 1 },
        scopeMetrics: rep("ScopeMetrics", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    ScopeMetrics: {
      fields: {
        scope: { type: "InstrumentationScope", id: 1 },
        metrics: rep("Metric", 2),
        schemaUrl: { type: "string", id: 3 },
      },
    },
    Metric: {
      oneofs: { data: { oneof: ["gauge", "sum", "histogram"] } },
      fields: {
        name: { type: "string", id: 1 },
        description: { type: "string", id: 2 },
        unit: { type: "string", id: 3 },
        gauge: { type: "Gauge", id: 5 },
        sum: { type: "Sum", id: 7 },
        histogram: { type: "Histogram", id: 9 },
        metadata: rep("KeyValue", 12),
      },
    },
    Gauge: { fields: { dataPoints: rep("NumberDataPoint", 1) } },
    Sum: {
      fields: {
        dataPoints: rep("NumberDataPoint", 1),
        aggregationTemporality: { type: "int32", id: 2 },
        isMonotonic: { type: "bool", id: 3 },
      },
    },
    Histogram: {
      fields: {
        dataPoints: rep("HistogramDataPoint", 1),
        aggregationTemporality: { type: "int32", id: 2 },
      },
    },
    NumberDataPoint: {
      oneofs: { value: { oneof: ["asDouble", "asInt"] } },
      fields: {
        attributes: rep("KeyValue", 7),
        startTimeUnixNano: { type: "fixed64", id: 2 },
        timeUnixNano: { type: "fixed64", id: 3 },
        asDouble: { type: "double", id: 4 },
        asInt: { type: "sfixed64", id: 6 },
        flags: { type: "uint32", id: 8 },
      },
    },
    HistogramDataPoint: {
      fields: {
        attributes: rep("KeyValue", 9),
        startTimeUnixNano: { type: "fixed64", id: 2 },
        timeUnixNano: { type: "fixed64", id: 3 },
        count: { type: "fixed64", id: 4 },
        sum: { type: "double", id: 5, options: { proto3_optional: true } },
        bucketCounts: { ...rep("fixed64", 6), options: { packed: true } },
        explicitBounds: { ...rep("double", 7), options: { packed: true } },
        flags: { type: "uint32", id: 10 },
        min: { type: "double", id: 11, options: { proto3_optional: true } },
        max: { type: "double", id: 12, options: { proto3_optional: true } },
      },
    },
  },
};

/** The loaded schema. */
const root = protobuf.Root.fromJSON(DESCRIPTOR);

/** Each signal's request message. */
const REQUEST_TYPES: Record<OtlpSignal, protobuf.Type> = {
  traces: root.lookupType("ExportTraceServiceRequest"),
  metrics: root.lookupType("ExportMetricsServiceRequest"),
  logs: root.lookupType("ExportLogsServiceRequest"),
};

/** Fields OTLP/JSON writes as hex rather than base64. */
const HEX_ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);

/**
 * Walk a decoded message into OTLP/JSON: ids to hex, other bytes to base64.
 * @param value - A protobufjs plain object.
 * @param key - The field it sits under.
 * @returns The JSON form.
 */
function toJson(value: unknown, key = ""): unknown {
  if (value instanceof Uint8Array) {
    return HEX_ID_FIELDS.has(key)
      ? Buffer.from(value).toString("hex")
      : Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map((v) => toJson(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v, k);
    return out;
  }
  return value;
}

/**
 * Walk OTLP/JSON into what protobufjs's `fromObject` reads: hex ids to bytes
 * (it reads any other string bytes field as base64, as OTLP/JSON writes it).
 * @param value - OTLP/JSON.
 * @param key - The field it sits under.
 * @returns The object.
 */
function fromJson(value: unknown, key = ""): unknown {
  if (typeof value === "string" && HEX_ID_FIELDS.has(key)) {
    return /^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0
      ? Buffer.from(value, "hex")
      : Buffer.alloc(0);
  }
  if (Array.isArray(value)) return value.map((v) => fromJson(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromJson(v, k);
    return out;
  }
  return value;
}

/**
 * Encode an OTLP/JSON request as OTLP/protobuf.
 * @param signal - Which request it is.
 * @param request - The request.
 * @returns The protobuf bytes.
 */
export function encodeOtlpProtobuf<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
): Uint8Array {
  const type = REQUEST_TYPES[signal];
  return type.encode(type.fromObject(fromJson(request) as object)).finish();
}

/**
 * Decode an OTLP/protobuf request into OTLP/JSON.
 * @param signal - Which request it is.
 * @param bytes - The protobuf bytes.
 * @returns The request.
 * @throws {Error} When the bytes are not that message.
 */
export function decodeOtlpProtobuf<S extends OtlpSignal>(
  signal: S,
  bytes: Uint8Array,
): OtlpRequestBySignal[S] {
  const type = REQUEST_TYPES[signal];
  const object = type.toObject(type.decode(bytes), {
    longs: String,
    defaults: false,
    arrays: false,
  });
  return toJson(object) as OtlpRequestBySignal[S];
}

/**
 * Read an OTLP/HTTP request body of either content type.
 * @param signal - Which request it is.
 * @param bytes - The body, already gunzipped.
 * @param contentType - The request's `Content-Type`.
 * @returns The request as OTLP/JSON.
 * @throws {Error} When the body is neither.
 */
export function decodeOtlpBody<S extends OtlpSignal>(
  signal: S,
  bytes: Uint8Array,
  contentType: string | null,
): OtlpRequestBySignal[S] {
  if ((contentType ?? "").toLowerCase().includes("json")) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an OTLP request");
    return parsed as OtlpRequestBySignal[S];
  }
  return decodeOtlpProtobuf(signal, bytes);
}

/**
 * The signal an OTLP/HTTP path is for (`…/v1/traces`).
 * @param path - The URL path.
 * @returns The signal, or null.
 */
export function signalOfPath(path: string): OtlpSignal | null {
  const match = /\/v1\/(traces|metrics|logs)\/?$/.exec(path);
  return match ? (match[1] as OtlpSignal) : null;
}

/**
 * An attribute.
 * @param key - The key.
 * @param value - A string, number, or boolean; null and undefined are dropped.
 * @returns The attribute, or null.
 */
export function attribute(
  key: string,
  value: string | number | boolean | null | undefined,
): KeyValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/**
 * A list of attributes from an object, dropping empty values.
 * @param values - Key to value.
 * @returns The attributes.
 */
export function attributes(
  values: Record<string, string | number | boolean | null | undefined>,
): KeyValue[] {
  return Object.entries(values).flatMap(([k, v]) => {
    const a = attribute(k, v);
    return a ? [a] : [];
  });
}

/**
 * An attribute's value as a plain JavaScript value.
 * @param value - The value.
 * @returns A string, number, boolean, array, object, or null.
 */
export function plainValue(value: AnyValue | undefined): unknown {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(plainValue);
  if (value.kvlistValue)
    return Object.fromEntries(
      (value.kvlistValue.values ?? []).map((kv) => [
        kv.key,
        plainValue(kv.value),
      ]),
    );
  if (value.bytesValue !== undefined) return value.bytesValue;
  return null;
}

/**
 * Epoch milliseconds as OTLP's nanosecond string.
 * @param ms - Epoch ms (fractions kept to the microsecond).
 * @returns Nanoseconds, as a decimal string.
 */
export function unixNano(ms: number): string {
  return (BigInt(Math.round(ms * 1000)) * 1000n).toString();
}
