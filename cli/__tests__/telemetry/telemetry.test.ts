import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTENT_ATTRIBUTE_PREFIX,
  encodeOtlpProtobuf,
  formatTraceparent,
  LEVEL_ATTRIBUTE,
  type LogsRequest,
  type MetricsRequest,
  newSpanId,
  newTraceId,
  type OtlpSignal,
  plainValue,
  type TracesRequest,
  unixNano,
  type WorkAssignment,
} from "../../../protocol/src/index";
import { ApiError } from "../../src/api/client";
import { TurnTelemetry } from "../../src/telemetry/collector";
import {
  dropInheritedOtel,
  nativeTelemetryLaunch,
} from "../../src/telemetry/native";
import { TelemetryQueue } from "../../src/telemetry/queue";
import { NativeReceiver } from "../../src/telemetry/receiver";

/** A sender that records what it posts and can fail. */
class Sender {
  posts: {
    workItemId: number;
    signal: OtlpSignal;
    body: unknown;
    traceparent: string;
  }[] = [];
  failWith: ApiError | null = null;
  delayMs = 0;

  async telemetry(batch: {
    workItemId: number;
    traceparent: string;
    signal: OtlpSignal;
    gzipped: Uint8Array;
  }) {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.failWith) throw this.failWith;
    this.posts.push({
      workItemId: batch.workItemId,
      signal: batch.signal,
      traceparent: batch.traceparent,
      body: JSON.parse(
        new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(batch.gzipped))),
      ),
    });
    return { accepted: true };
  }
}

const assignment = {
  workItemId: 7,
  agentSessionId: 3,
  externalSessionId: "lin-session",
  kind: "session_created",
  role: "worker",
  fresh: true,
  repository: { remote: "github.com/acme/web", baseBranch: "main" },
  issue: { identifier: "ENG-1", teamKey: "ENG" },
} as unknown as WorkAssignment;

const traceId = newTraceId();
const rootSpanId = newSpanId();

/**
 * A turn's telemetry over a queue.
 * @param content - The level.
 * @param queue - The queue.
 * @param secrets - Values to redact.
 * @returns The turn.
 */
function turnAt(
  content: "metadata" | "content" | "full",
  queue: TelemetryQueue,
  secrets: string[] = [],
) {
  return new TurnTelemetry({
    claim: {
      traceparent: formatTraceparent({
        traceId,
        spanId: rootSpanId,
        sampled: true,
      }),
      sampled: true,
      content,
      agentNative: true,
    },
    assignment,
    runner: { name: "laptop" },
    agentId: "claude",
    preset: "claude",
    queue,
    secrets: () => secrets,
  });
}

/**
 * Every span posted, flattened.
 * @param sender - The sender.
 * @returns Name, parent, and attributes.
 */
function postedSpans(sender: Sender) {
  return sender.posts
    .filter((p) => p.signal === "traces")
    .flatMap((p) =>
      ((p.body as TracesRequest).resourceSpans ?? []).flatMap((rs) =>
        (rs.scopeSpans ?? []).flatMap((ss) =>
          (ss.spans ?? []).map((s) => ({
            ...s,
            attrs: Object.fromEntries(
              (s.attributes ?? []).map((a) => [a.key, plainValue(a.value)]),
            ),
            resource: Object.fromEntries(
              (rs.resource?.attributes ?? []).map((a) => [
                a.key,
                plainValue(a.value),
              ]),
            ),
          })),
        ),
      ),
    );
}

/**
 * Every log record posted.
 * @param sender - The sender.
 * @returns The records.
 */
function postedLogs(sender: Sender) {
  return sender.posts
    .filter((p) => p.signal === "logs")
    .flatMap((p) =>
      ((p.body as LogsRequest).resourceLogs ?? []).flatMap((rl) =>
        (rl.scopeLogs ?? []).flatMap((sl) => sl.logRecords ?? []),
      ),
    );
}

describe("a turn's telemetry", () => {
  test("daemon.turn is the server root's child, and spans nest under it", async () => {
    const sender = new Sender();
    const queue = new TelemetryQueue(sender, 1 << 20);
    const turn = turnAt("metadata", queue);
    const prompt = turn.span("acp.prompt");
    turn.span("tool_call", {}, prompt).end();
    prompt.end();
    turn.finish("completed");
    await queue.drain(1000);
    const spans = postedSpans(sender);
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName["daemon.turn"]?.parentSpanId).toBe(rootSpanId);
    expect(byName["acp.prompt"]?.parentSpanId).toBe(
      byName["daemon.turn"]?.spanId,
    );
    expect(byName["tool_call"]?.parentSpanId).toBe(
      byName["acp.prompt"]?.spanId,
    );
    expect(spans.every((s) => s.traceId === traceId)).toBe(true);
    expect(byName["daemon.turn"]?.resource).toMatchObject({
      "service.name": "hypotenuse-daemon",
      "hypotenuse.work_item.id": 7,
      "hypotenuse.runner.name": "laptop",
      "linear.issue.identifier": "ENG-1",
    });
    // Every post names the turn's daemon span as its traceparent.
    expect(sender.posts[0]?.traceparent).toBe(turn.traceparentFor());
  });

  test("metadata records sizes only; content adds the text, capped; full adds frames", async () => {
    for (const level of ["metadata", "content", "full"] as const) {
      const sender = new Sender();
      const queue = new TelemetryQueue(sender, 1 << 20);
      const turn = turnAt(level, queue);
      turn.span("acp.prompt").content("prompt", "fix the bug").end();
      turn
        .span("big")
        .content("output", "x".repeat(70 * 1024))
        .end();
      turn.log({ body: "stderr line", eventName: "agent.stderr" });
      turn.frame("-> ", { jsonrpc: "2.0", method: "session/prompt", id: 1 });
      turn.finish("completed");
      await queue.drain(1000);
      const spans = postedSpans(sender);
      const prompt = spans.find((s) => s.name === "acp.prompt")?.attrs ?? {};
      const big = spans.find((s) => s.name === "big")?.attrs ?? {};
      expect(prompt["hypotenuse.prompt.bytes"]).toBe(11);
      const logs = postedLogs(sender);
      if (level === "metadata") {
        expect(
          Object.keys(prompt).some((k) =>
            k.startsWith(CONTENT_ATTRIBUTE_PREFIX),
          ),
        ).toBe(false);
        expect(logs).toEqual([]);
      } else {
        expect(prompt[`${CONTENT_ATTRIBUTE_PREFIX}prompt`]).toBe("fix the bug");
        expect(String(big[`${CONTENT_ATTRIBUTE_PREFIX}output`]).length).toBe(
          64 * 1024,
        );
        expect(big[`${CONTENT_ATTRIBUTE_PREFIX}output.original_bytes`]).toBe(
          70 * 1024,
        );
        const levels = logs.map(
          (l) =>
            l.attributes?.find((a) => a.key === LEVEL_ATTRIBUTE)?.value
              ?.stringValue,
        );
        expect(levels).toEqual(
          level === "full" ? ["content", "full"] : ["content"],
        );
      }
    }
  });

  test("an unsampled turn sends metrics only", async () => {
    const sender = new Sender();
    const queue = new TelemetryQueue(sender, 1 << 20);
    const turn = new TurnTelemetry({
      claim: {
        traceparent: formatTraceparent({
          traceId,
          spanId: rootSpanId,
          sampled: false,
        }),
        sampled: false,
        content: "full",
        agentNative: true,
      },
      assignment,
      runner: { name: "laptop" },
      agentId: "claude",
      preset: null,
      queue,
      secrets: () => [],
    });
    turn.span("acp.prompt").end();
    turn.log({ body: "x" });
    turn.usage({ inputTokens: 10, outputTokens: 5 });
    turn.finish("completed");
    await queue.drain(1000);
    expect(sender.posts.map((p) => p.signal)).toEqual(["metrics"]);
  });

  test("secrets are redacted by value before anything is queued", async () => {
    const sender = new Sender();
    const queue = new TelemetryQueue(sender, 1 << 20);
    const cliToken = "hyp_cli_AbCdEfGhIjKlMnOpQrStUv";
    const turn = turnAt("full", queue, ["runner-secret-value", cliToken]);
    turn.addSecret("receiver-nonce-123456");
    turn
      .span("tool_call")
      .content(
        "tool.output",
        `env runner-secret-value then ${cliToken} and receiver-nonce-123456`,
      )
      .end();
    turn.finish("completed");
    await queue.drain(1000);
    const all = JSON.stringify(sender.posts);
    for (const secret of [
      "runner-secret-value",
      cliToken,
      "receiver-nonce-123456",
    ])
      expect(all.includes(secret), secret).toBe(false);
    expect(all).toContain("[REDACTED]");
  });
});

describe("the queue", () => {
  test("a full buffer drops the oldest logs, then spans, never metrics, and counts them", async () => {
    const sender = new Sender();
    const queue = new TelemetryQueue(sender, 4096);
    const turn = turnAt("content", queue);
    for (let i = 0; i < 40; i++)
      turn.log({ body: `log ${i} ${"y".repeat(100)}` });
    for (let i = 0; i < 20; i++) turn.span(`span-${i}`).end();
    turn.usage({ inputTokens: 1, outputTokens: 1 });
    expect(queue.pendingBytes).toBeLessThanOrEqual(4096);
    await queue.drain(1000);
    const dropped = queue.droppedTotal.get(7) ?? 0;
    expect(dropped).toBeGreaterThan(0);
    const metrics = sender.posts
      .filter((p) => p.signal === "metrics")
      .flatMap((p) =>
        ((p.body as MetricsRequest).resourceMetrics ?? []).flatMap((rm) =>
          (rm.scopeMetrics ?? []).flatMap((sm) => sm.metrics ?? []),
        ),
      );
    expect(metrics.map((m) => m.name)).toContain("gen_ai.client.token.usage");
    const lost = metrics.find((m) => m.name === "hypotenuse.telemetry.dropped");
    const total = (lost?.sum?.dataPoints ?? []).reduce(
      (n, p) => n + Number(p.asInt),
      0,
    );
    expect(total).toBe(dropped);
    // The most recent spans survived; the oldest logs went first.
    const logs = postedLogs(sender).map((l) => l.body?.stringValue ?? "");
    expect(logs.some((l) => l.startsWith("log 0 "))).toBe(false);
  });

  test("a failing relay never blocks a turn, retries, and keeps within the buffer", async () => {
    const sender = new Sender();
    sender.failWith = new ApiError("unavailable", 503);
    const queue = new TelemetryQueue(sender, 8192);
    const turn = turnAt("content", queue);
    const started = Date.now();
    for (let i = 0; i < 200; i++)
      turn.log({ body: `line ${i} ${"z".repeat(200)}` });
    turn.finish("completed");
    expect(Date.now() - started).toBeLessThan(500);
    await queue.flush();
    expect(queue.pendingBytes).toBeLessThanOrEqual(8192);
    expect(sender.posts).toEqual([]);
    sender.failWith = null;
    await queue.drain(3000);
    expect(sender.posts.length).toBeGreaterThan(0);
    expect(queue.droppedTotal.get(7) ?? 0).toBeGreaterThan(0);
  });

  test("a turn the server refuses (410, 409) is forgotten and counted", async () => {
    const sender = new Sender();
    sender.failWith = new ApiError("late", 410, "TELEMETRY_LATE");
    const queue = new TelemetryQueue(sender, 1 << 20);
    const turn = turnAt("metadata", queue);
    turn.span("one").end();
    await queue.flush();
    expect(queue.isRefused(7)).toBe(true);
    sender.failWith = null;
    turn.span("two").end();
    await queue.drain(500);
    expect(sender.posts).toEqual([]);
    expect(queue.droppedTotal.get(7)).toBe(2);
  });
});

describe("native telemetry", () => {
  const receivers: NativeReceiver[] = [];
  afterEach(async () => {
    for (const r of receivers.splice(0)) await r.close(0);
  });

  test("each preset is pointed at the receiver; prompts are asked for only at full", () => {
    const target = {
      endpoint: "http://127.0.0.1:1/n",
      level: "content" as const,
    };
    const claude = nativeTelemetryLaunch("claude", target);
    expect(claude.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1/n",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_TRACES_EXPORTER: "otlp",
      HYPOTENUSE_OTLP_ENDPOINT: "http://127.0.0.1:1/n",
    });
    expect(claude.env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(
      nativeTelemetryLaunch("claude", { ...target, level: "full" }).env,
    ).toMatchObject({
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
    });
    expect(nativeTelemetryLaunch("gemini", target).env).toMatchObject({
      GEMINI_TELEMETRY_ENABLED: "true",
      GEMINI_TELEMETRY_OTLP_ENDPOINT: "http://127.0.0.1:1/n",
      GEMINI_TELEMETRY_LOG_PROMPTS: "false",
    });
    expect(nativeTelemetryLaunch("codex", target).args).toEqual([
      "-c",
      'otel.exporter={otlp-http={endpoint="http://127.0.0.1:1/n",protocol="json"}}',
      "-c",
      "otel.log_user_prompt=false",
    ]);
    const custom = nativeTelemetryLaunch(null, target);
    expect(custom.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:1/n");
    const env: Record<string, string> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://elsewhere",
      PATH: "/bin",
    };
    dropInheritedOtel(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("the receiver takes protobuf and gzipped JSON under its nonce, joins the turn, and tags the level", async () => {
    const sender = new Sender();
    const queue = new TelemetryQueue(sender, 1 << 20);
    const turn = turnAt("content", queue);
    const receiver = new NativeReceiver(turn);
    receivers.push(receiver);
    const base = receiver.start();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}$/);
    const own = newTraceId();
    const spans: TracesRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "agent" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: own,
                  spanId: newSpanId(),
                  name: "model.request",
                  startTimeUnixNano: unixNano(Date.now()),
                  endTimeUnixNano: unixNano(Date.now()),
                },
                {
                  // A protobuf exporter marks a root with an all-zero parent.
                  traceId: own,
                  spanId: newSpanId(),
                  parentSpanId: "0000000000000000",
                  name: "zero.parent",
                  startTimeUnixNano: unixNano(Date.now()),
                  endTimeUnixNano: unixNano(Date.now()),
                },
              ],
            },
          ],
        },
      ],
    };
    const protobuf = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body: new Uint8Array(encodeOtlpProtobuf("traces", spans)),
    });
    expect(protobuf.status).toBe(200);
    const logs: LogsRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            { logRecords: [{ body: { stringValue: "api_request" } }] },
          ],
        },
      ],
    };
    const gz = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: Bun.gzipSync(new TextEncoder().encode(JSON.stringify(logs))),
    });
    expect(gz.status).toBe(200);
    const guessed = await fetch(
      `${base.replace(/\/[^/]+$/, "/guess")}/v1/traces`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(guessed.status).toBe(404);
    turn.finish("completed");
    await queue.drain(1000);
    const span = postedSpans(sender).find((s) => s.name === "model.request");
    expect(span?.traceId).toBe(traceId);
    expect(span?.parentSpanId).toBe(turn.turnSpan.spanId);
    const zero = postedSpans(sender).find((s) => s.name === "zero.parent");
    expect(zero?.traceId).toBe(traceId);
    expect(zero?.parentSpanId).toBe(turn.turnSpan.spanId);
    expect(span?.attrs[LEVEL_ATTRIBUTE]).toBe("content");
    expect(span?.resource["hypotenuse.source"]).toBe("agent_native");
    expect(span?.resource["service.name"]).toBe("agent");
    expect(span?.resource["hypotenuse.work_item.id"]).toBe(7);
    const log = postedLogs(sender).find(
      (l) => l.body?.stringValue === "api_request",
    );
    expect(log?.traceId).toBe(traceId);
    // The nonce never leaves in what the receiver queued.
    expect(JSON.stringify(sender.posts)).not.toContain(receiver.nonce);
  });
});
