import { describe, expect, test } from "bun:test";
import {
  attributes,
  CONTENT_CAP_BYTES,
  capContent,
  decodeOtlpBody,
  decodeOtlpProtobuf,
  encodeOtlpProtobuf,
  filterForLevel,
  formatTraceparent,
  LEVEL_ATTRIBUTE,
  type LogsRequest,
  type MetricsRequest,
  newSpanId,
  newTraceId,
  parseTraceparent,
  REDACTED,
  redactOtlp,
  sampledBy,
  sampleNumber,
  signalOfPath,
  type TracesRequest,
} from "../src/index";

/** A trace with one span carrying a content attribute and an event. */
function traces(): TracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ "service.name": "test" }) },
        scopeSpans: [
          {
            scope: { name: "hypotenuse" },
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                parentSpanId: "00f067aa0ba902b7",
                name: "acp.prompt",
                kind: 1,
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001000000000",
                attributes: attributes({
                  "gen_ai.operation.name": "invoke_agent",
                  "hypotenuse.content.prompt": "fix the bug",
                  "hypotenuse.prompt.bytes": 11,
                  ratio: 0.5,
                  ok: true,
                }),
                events: [
                  {
                    timeUnixNano: "1700000000500000000",
                    name: "thought",
                    attributes: attributes({
                      "hypotenuse.content.text": "thinking",
                      "hypotenuse.bytes": 8,
                    }),
                  },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("the OTLP codec", () => {
  test("traces round-trip through protobuf unchanged", () => {
    const request = traces();
    const bytes = encodeOtlpProtobuf("traces", request);
    expect(decodeOtlpProtobuf("traces", bytes)).toEqual(request);
  });

  test("logs and metrics round-trip too", () => {
    const logs: LogsRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  severityNumber: 9,
                  body: { stringValue: "hello" },
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                  attributes: attributes({ [LEVEL_ATTRIBUTE]: "full" }),
                },
              ],
            },
          ],
        },
      ],
    };
    expect(
      decodeOtlpProtobuf("logs", encodeOtlpProtobuf("logs", logs)),
    ).toEqual(logs);
    const metrics: MetricsRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "hypotenuse.telemetry.dropped",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      { timeUnixNano: "1700000000000000000", asInt: "3" },
                    ],
                  },
                },
                {
                  name: "gen_ai.client.token.usage",
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        timeUnixNano: "1700000000000000000",
                        count: "1",
                        sum: 120,
                        bucketCounts: ["0", "1"],
                        explicitBounds: [100],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(
      decodeOtlpProtobuf("metrics", encodeOtlpProtobuf("metrics", metrics)),
    ).toEqual(metrics);
  });

  test("a body is read by its content type", () => {
    const request = traces();
    const json = new TextEncoder().encode(JSON.stringify(request));
    expect(decodeOtlpBody("traces", json, "application/json")).toEqual(request);
    expect(
      decodeOtlpBody(
        "traces",
        encodeOtlpProtobuf("traces", request),
        "application/x-protobuf",
      ),
    ).toEqual(request);
    expect(signalOfPath("/abc/v1/traces")).toBe("traces");
    expect(signalOfPath("/v1/logs/")).toBe("logs");
    expect(signalOfPath("/v1/profiles")).toBeNull();
  });
});

describe("content levels", () => {
  test("metadata drops content attributes and content-level records", () => {
    const filtered = filterForLevel("traces", traces(), "metadata");
    const span = filtered.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.attributes?.map((a) => a.key)).toEqual([
      "gen_ai.operation.name",
      "hypotenuse.prompt.bytes",
      "ratio",
      "ok",
    ]);
    expect(span?.events?.[0]?.attributes?.map((a) => a.key)).toEqual([
      "hypotenuse.bytes",
    ]);
    expect(filterForLevel("traces", traces(), "content")).toEqual(traces());
  });

  test("a record that needs full reaches only full", () => {
    const logs: LogsRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { attributes: attributes({ [LEVEL_ATTRIBUTE]: "full" }) },
                { attributes: attributes({ [LEVEL_ATTRIBUTE]: "content" }) },
                { attributes: attributes({ a: 1 }) },
              ],
            },
          ],
        },
      ],
    };
    const count = (r: LogsRequest) =>
      r.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.length ?? 0;
    expect(count(filterForLevel("logs", logs, "full"))).toBe(3);
    expect(count(filterForLevel("logs", logs, "content"))).toBe(2);
    expect(count(filterForLevel("logs", logs, "metadata"))).toBe(1);
  });

  test("the cap cuts at 64 KB and says how big it was", () => {
    const big = "é".repeat(CONTENT_CAP_BYTES);
    const { text, originalBytes } = capContent(big);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTENT_CAP_BYTES);
    expect(text.endsWith("�")).toBe(false);
    expect(originalBytes).toBe(CONTENT_CAP_BYTES * 2);
    expect(capContent("small")).toEqual({ text: "small", originalBytes: null });
  });
});

describe("trace context and sampling", () => {
  test("a traceparent round-trips and a bad one is refused", () => {
    const ctx = { traceId: newTraceId(), spanId: newSpanId(), sampled: true };
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
    expect(
      parseTraceparent(formatTraceparent({ ...ctx, sampled: false }))?.sampled,
    ).toBe(false);
    for (const bad of [
      null,
      "",
      "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      `00-${"0".repeat(32)}-b7ad6b7169203331-01`,
      "00-xyz-b7ad6b7169203331-01",
    ])
      expect(parseTraceparent(bad)).toBeNull();
  });

  test("a lower ratio keeps a subset of a higher one", () => {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 2000; i++) {
      const id = newTraceId();
      const n = sampleNumber(id);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
      if (sampledBy(id, 0.2)) {
        low++;
        expect(sampledBy(id, 0.6)).toBe(true);
      }
      if (sampledBy(id, 0.6)) high++;
      expect(sampledBy(id, 0)).toBe(false);
      expect(sampledBy(id, 1)).toBe(true);
    }
    expect(low / 2000).toBeGreaterThan(0.12);
    expect(low / 2000).toBeLessThan(0.28);
    expect(high / 2000).toBeGreaterThan(0.5);
    expect(high / 2000).toBeLessThan(0.7);
  });
});

describe("redaction", () => {
  test("values, patterns, and credential keys are redacted; ids are not", () => {
    const request = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  body: {
                    stringValue:
                      "token hyp_rt_abcdefghijklmnop and s3cret-value and sk-ant-0123456789abcdefghij",
                  },
                  attributes: attributes({
                    "http.request.header.x-api-key": "anything",
                    authorization: "whatever",
                    "linear.team.key": "ENG",
                    note: "AKIAABCDEFGHIJKLMNOP",
                  }),
                },
              ],
            },
          ],
        },
      ],
    };
    const out = redactOtlp(request, { values: ["s3cret-value", "abc"] });
    const record = out.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(record?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(record?.body.stringValue).toBe(
      `token ${REDACTED} and ${REDACTED} and ${REDACTED}`,
    );
    expect(
      Object.fromEntries(
        (record?.attributes ?? []).map((a) => [a.key, a.value?.stringValue]),
      ),
    ).toEqual({
      "http.request.header.x-api-key": REDACTED,
      authorization: REDACTED,
      "linear.team.key": "ENG",
      note: REDACTED,
    });
  });
});
