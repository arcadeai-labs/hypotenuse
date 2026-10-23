/**
 * One turn's telemetry, as the daemon collects it: the `daemon.turn` span
 * and its tree, span events and log records at the turn's content level,
 * every ACP frame at `full`, and the turn's metrics — all OTLP/JSON, redacted,
 * and queued for the relay.
 *
 * The trace is the server's: the claim's `traceparent` names the turn's trace
 * and its root `turn` span, and `daemon.turn` is that span's child. Every
 * `daemon:*` call made for the turn carries {@link TurnTelemetry.traceparent}
 * so the server's span for it lands under the daemon span it was made from.
 *
 * Levels, from {@link ContentLevel}: at `metadata` nothing free-form is
 * recorded — names, ids, timings, sizes, counts, statuses; `content` adds
 * free text under `hypotenuse.content.*` (capped at 64 KB, the original size
 * recorded beside it), and `full` adds a log record per ACP frame. A record
 * that is content through and through carries its level
 * (`hypotenuse.telemetry.level`), so the worker can filter a batch down for
 * an exporter at a lower level than the turn was collected at.
 */
import {
  attributes,
  type ClaimTelemetry,
  CONTENT_ATTRIBUTE_PREFIX,
  type ContentLevel,
  capContent,
  formatTraceparent,
  type KeyValue,
  LEVEL_ATTRIBUTE,
  levelRank,
  newSpanId,
  type OtlpMetric,
  type OtlpRequestBySignal,
  type OtlpSpan,
  parseTraceparent,
  redactOtlp,
  SEVERITY,
  SPAN_KIND,
  STATUS_CODE,
  TEMPORALITY,
  TRUNCATED_SUFFIX,
  unixNano,
  type WorkAssignment,
} from "../../../protocol/src/index";
import pkg from "../../package.json";
import type { TelemetryQueue } from "./queue";

/** An attribute value. */
type Scalar = string | number | boolean | null | undefined;

/** The instrumentation scope the daemon writes under. */
const SCOPE = { name: "hypotenuse.daemon", version: pkg.version };

/** Token-usage histogram bounds. */
const TOKEN_BOUNDS = [
  100, 1000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
];

/** A span being recorded. */
export class SpanHandle {
  readonly spanId: string;
  private readonly startMs: number;
  private readonly attrs: Record<string, Scalar> = {};
  private readonly events: OtlpSpan["events"] = [];
  private ended = false;
  private error: string | null = null;

  /**
   * @param turn - The turn it belongs to.
   * @param name - The span's name.
   * @param parentSpanId - Its parent.
   * @param kind - Its kind.
   * @param attrs - Its first attributes.
   * @param spanId - Its id, when it was reserved in advance (a
   *   `TRACEPARENT` handed to an agent before its span started).
   */
  constructor(
    private readonly turn: TurnTelemetry,
    readonly name: string,
    readonly parentSpanId: string,
    private readonly kind: keyof typeof SPAN_KIND = "internal",
    attrs: Record<string, Scalar> = {},
    spanId: string = newSpanId(),
  ) {
    this.spanId = spanId;
    this.startMs = turn.now();
    Object.assign(this.attrs, attrs);
  }

  /**
   * Add attributes.
   * @param attrs - Key to value; free text belongs in {@link content}.
   * @returns This span.
   */
  set(attrs: Record<string, Scalar>): this {
    Object.assign(this.attrs, attrs);
    return this;
  }

  /**
   * Add a free-text attribute, if the turn collects content.
   * @param key - Its name, without the content prefix.
   * @param text - The text.
   * @returns This span.
   */
  content(key: string, text: string | null | undefined): this {
    Object.assign(this.attrs, this.turn.contentAttrs(key, text));
    return this;
  }

  /**
   * Add a span event.
   * @param name - The event.
   * @param attrs - Its attributes (content ones already filtered by the caller).
   * @returns This span.
   */
  event(name: string, attrs: Record<string, Scalar> = {}): this {
    if (!this.ended)
      this.events?.push({
        name,
        timeUnixNano: unixNano(this.turn.now()),
        attributes: attributes(attrs),
      });
    return this;
  }

  /**
   * Mark it failed.
   * @param message - Why.
   * @returns This span.
   */
  fail(message: string): this {
    this.error = message.slice(0, 1024);
    return this;
  }

  /** The `traceparent` a call made from this span carries. */
  get traceparent(): string {
    return this.turn.traceparentFor(this.spanId);
  }

  /** Whether it has ended. */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * End it and queue it. Ending twice is a no-op.
   * @param attrs - Last attributes.
   */
  end(attrs: Record<string, Scalar> = {}): void {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.attrs, attrs);
    this.turn.record({
      traceId: this.turn.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: SPAN_KIND[this.kind],
      startTimeUnixNano: unixNano(this.startMs),
      endTimeUnixNano: unixNano(this.turn.now()),
      attributes: attributes(this.attrs),
      events: this.events,
      status: this.error
        ? { code: STATUS_CODE.error, message: this.error }
        : { code: STATUS_CODE.unset },
    });
  }
}

/** What a turn's telemetry is built from. */
export interface TurnTelemetryOptions {
  claim: ClaimTelemetry;
  assignment: WorkAssignment;
  runner: { name: string };
  agentId: string;
  preset: string | null;
  queue: TelemetryQueue;
  /** Every secret value to redact (tokens, nonces, `$VAR`-resolved values). */
  secrets: () => Iterable<string>;
  now?: () => number;
}

/** One turn's telemetry. */
export class TurnTelemetry {
  readonly traceId: string;
  /** The server's root `turn` span. */
  readonly rootSpanId: string;
  /** What this turn collects at. */
  readonly level: ContentLevel;
  /** Whether any exporter keeps the turn's spans and logs. */
  readonly sampled: boolean;
  /** Whether to capture the agent's own telemetry. */
  readonly agentNative: boolean;
  readonly now: () => number;
  /** The daemon's span for the whole turn. */
  readonly turnSpan: SpanHandle;
  private readonly resource: KeyValue[];
  private finished = false;
  /** Secrets minted during the turn (the receiver's nonce). */
  private readonly extraSecrets: string[] = [];
  /**
   * The `acp.prompt` span while the prompt runs: what the agent's tool
   * calls through the MCP broker are children of.
   */
  promptSpan: SpanHandle | null = null;

  /**
   * @param options - The claim and the turn.
   */
  constructor(private readonly options: TurnTelemetryOptions) {
    const ctx = parseTraceparent(options.claim.traceparent);
    this.traceId = ctx?.traceId ?? "0".repeat(32);
    this.rootSpanId = ctx?.spanId ?? "0".repeat(16);
    this.level = options.claim.content;
    this.sampled = options.claim.sampled && ctx !== null;
    this.agentNative = options.claim.agentNative;
    this.now = options.now ?? Date.now;
    const a = options.assignment;
    this.resource = attributes({
      "service.name": "hypotenuse-daemon",
      "service.namespace": "hypotenuse",
      "service.version": pkg.version,
      "hypotenuse.source": "daemon",
      ...this.turnAttributes(),
      "hypotenuse.repository": a.repository?.remote ?? null,
    });
    this.turnSpan = new SpanHandle(
      this,
      "daemon.turn",
      this.rootSpanId,
      "internal",
      {
        ...this.turnAttributes(),
        "hypotenuse.work_item.kind": a.kind,
        "hypotenuse.work_item.fresh": a.fresh,
        "hypotenuse.telemetry.content": this.level,
        "hypotenuse.telemetry.agent_native": this.agentNative,
      },
    );
  }

  /**
   * The attributes every resource and root span of a turn carries, as far as
   * the daemon knows them (the server adds the project and the turn ordinal).
   * @returns The attributes.
   */
  turnAttributes(): Record<string, Scalar> {
    const a = this.options.assignment;
    return {
      "hypotenuse.session.id": a.agentSessionId,
      "hypotenuse.work_item.id": a.workItemId,
      "hypotenuse.role": a.role,
      "hypotenuse.runner.name": this.options.runner.name,
      "hypotenuse.agent.id": this.options.agentId,
      "hypotenuse.agent.preset": this.options.preset ?? "custom",
      "hypotenuse.repository": a.repository?.remote ?? null,
      "linear.issue.identifier": a.issue.identifier,
      "linear.agent_session.id": a.externalSessionId,
      "linear.team.key": a.issue.teamKey,
    };
  }

  /**
   * Redact a value minted during the turn from everything it sends.
   * @param value - The secret.
   */
  addSecret(value: string): void {
    this.extraSecrets.push(value);
  }

  /** The turn's resource attributes. */
  get resourceAttributes(): KeyValue[] {
    return this.resource;
  }

  /**
   * Whether the turn collects at least a level.
   * @param level - The level.
   * @returns True when it does.
   */
  collects(level: ContentLevel): boolean {
    return levelRank(this.level) >= levelRank(level);
  }

  /**
   * The `traceparent` for a call made from a span.
   * @param spanId - The span (default `daemon.turn`).
   * @returns The header value.
   */
  traceparentFor(spanId = this.turnSpan.spanId): string {
    return formatTraceparent({
      traceId: this.traceId,
      spanId,
      sampled: this.sampled,
    });
  }

  /**
   * Start a span.
   * @param name - Its name.
   * @param attrs - Its attributes.
   * @param parent - Its parent (default `daemon.turn`).
   * @param kind - Its kind.
   * @param spanId - A reserved id.
   * @returns The span.
   */
  span(
    name: string,
    attrs: Record<string, Scalar> = {},
    parent: SpanHandle | null = null,
    kind: keyof typeof SPAN_KIND = "internal",
    spanId?: string,
  ): SpanHandle {
    return new SpanHandle(
      this,
      name,
      (parent ?? this.turnSpan).spanId,
      kind,
      attrs,
      spanId,
    );
  }

  /**
   * A free-text attribute, when the turn collects content: capped, with the
   * original size beside it when cut; and its size always.
   * @param key - Its name, without the content prefix.
   * @param text - The text.
   * @returns The attributes to add.
   */
  contentAttrs(
    key: string,
    text: string | null | undefined,
  ): Record<string, Scalar> {
    if (text === null || text === undefined) return {};
    const out: Record<string, Scalar> = {
      [`hypotenuse.${key}.bytes`]: Buffer.byteLength(text),
    };
    if (!this.collects("content")) return out;
    const { text: kept, originalBytes } = capContent(text);
    out[`${CONTENT_ATTRIBUTE_PREFIX}${key}`] = kept;
    if (originalBytes !== null)
      out[`${CONTENT_ATTRIBUTE_PREFIX}${key}${TRUNCATED_SUFFIX}`] =
        originalBytes;
    return out;
  }

  /**
   * Queue an ended span.
   * @param span - The span.
   */
  record(span: OtlpSpan): void {
    if (!this.sampled || this.finished) return;
    this.enqueue("traces", {
      resourceSpans: [
        {
          resource: { attributes: this.resource },
          scopeSpans: [{ scope: SCOPE, spans: [span] }],
        },
      ],
    });
  }

  /**
   * Queue a log record, if the turn collects at its level.
   * @param record - The body, its level (default `content`), attributes, and span.
   */
  log(record: {
    body: string;
    level?: ContentLevel;
    severity?: keyof typeof SEVERITY;
    eventName?: string;
    attrs?: Record<string, Scalar>;
    span?: SpanHandle | null;
  }): void {
    const level = record.level ?? "content";
    if (!this.sampled || this.finished || !this.collects(level)) return;
    const { text, originalBytes } = capContent(record.body);
    this.enqueue("logs", {
      resourceLogs: [
        {
          resource: { attributes: this.resource },
          scopeLogs: [
            {
              scope: SCOPE,
              logRecords: [
                {
                  timeUnixNano: unixNano(this.now()),
                  observedTimeUnixNano: unixNano(this.now()),
                  severityNumber: SEVERITY[record.severity ?? "info"],
                  severityText: (record.severity ?? "info").toUpperCase(),
                  body: { stringValue: text },
                  ...(record.eventName ? { eventName: record.eventName } : {}),
                  attributes: attributes({
                    ...(record.attrs ?? {}),
                    [LEVEL_ATTRIBUTE]: level,
                    ...(originalBytes !== null
                      ? {
                          [`hypotenuse.body${TRUNCATED_SUFFIX}`]: originalBytes,
                        }
                      : {}),
                  }),
                  traceId: this.traceId,
                  spanId: (record.span ?? this.turnSpan).spanId,
                },
              ],
            },
          ],
        },
      ],
    });
  }

  /**
   * One ACP JSON-RPC frame, verbatim, at `full`.
   * @param direction - `->` to the agent, `<-` from it.
   * @param message - The frame.
   * @param span - The span it belongs to.
   */
  frame(direction: string, message: unknown, span?: SpanHandle | null): void {
    if (!this.collects("full")) return;
    const m = message as { method?: string; id?: unknown };
    this.log({
      body: typeof message === "string" ? message : JSON.stringify(message),
      level: "full",
      eventName: "acp.frame",
      attrs: {
        "hypotenuse.acp.direction": direction.startsWith("<-") ? "in" : "out",
        "rpc.method": typeof m?.method === "string" ? m.method : null,
        "rpc.jsonrpc.request_id":
          typeof m?.id === "string" || typeof m?.id === "number"
            ? String(m.id)
            : null,
      },
      span,
    });
  }

  /**
   * Record token usage in `gen_ai.client.token.usage` — a metric, so
   * unsampled turns report it too.
   * @param usage - Input and output tokens.
   */
  usage(usage: { inputTokens?: number; outputTokens?: number }): void {
    if (this.finished) return;
    const points = (
      [
        ["input", usage.inputTokens],
        ["output", usage.outputTokens],
      ] as const
    ).flatMap(([type, n]) =>
      typeof n === "number"
        ? [
            {
              attributes: attributes({
                "gen_ai.token.type": type,
                "gen_ai.agent.name": this.options.agentId,
              }),
              timeUnixNano: unixNano(this.now()),
              count: "1",
              sum: n,
              bucketCounts: [
                ...TOKEN_BOUNDS.map((b, i) =>
                  n <= b && (i === 0 || n > (TOKEN_BOUNDS[i - 1] as number))
                    ? "1"
                    : "0",
                ),
                n > (TOKEN_BOUNDS.at(-1) as number) ? "1" : "0",
              ],
              explicitBounds: TOKEN_BOUNDS,
              min: n,
              max: n,
            },
          ]
        : [],
    );
    if (points.length === 0) return;
    this.metric({
      name: "gen_ai.client.token.usage",
      unit: "{token}",
      histogram: {
        aggregationTemporality: TEMPORALITY.delta,
        dataPoints: points,
      },
    });
  }

  /**
   * The runner's slots, as the turn starts.
   * @param slots - Capacity and in use.
   */
  slots(slots: { capacity: number; inUse: number }): void {
    const at = unixNano(this.now());
    this.metric({
      name: "hypotenuse.runner.slots",
      unit: "{slot}",
      gauge: {
        dataPoints: [
          {
            attributes: attributes({ "hypotenuse.slot.state": "capacity" }),
            timeUnixNano: at,
            asInt: String(slots.capacity),
          },
          {
            attributes: attributes({ "hypotenuse.slot.state": "in_use" }),
            timeUnixNano: at,
            asInt: String(slots.inUse),
          },
        ],
      },
    });
  }

  /**
   * Queue a metric.
   * @param metric - The metric.
   */
  private metric(metric: OtlpMetric): void {
    this.enqueue("metrics", {
      resourceMetrics: [
        {
          resource: { attributes: this.resource },
          scopeMetrics: [{ scope: SCOPE, metrics: [metric] }],
        },
      ],
    });
  }

  /**
   * Redact and queue a batch the turn produced, or one the native receiver
   * captured.
   * @param signal - The signal.
   * @param body - The batch.
   */
  enqueue<S extends "traces" | "metrics" | "logs">(
    signal: S,
    body: OtlpRequestBySignal[S],
  ): void {
    // A refused turn's batch is only counted as dropped; no need to redact it.
    const refused = this.options.queue.isRefused(
      this.options.assignment.workItemId,
    );
    this.options.queue.add(
      {
        workItemId: this.options.assignment.workItemId,
        traceparent: this.traceparentFor(),
        signal,
        body: refused
          ? body
          : redactOtlp(body, {
              values: [...this.options.secrets(), ...this.extraSecrets],
            }),
      },
      this.resource,
    );
  }

  /**
   * End the turn's span; nothing more is recorded after.
   * @param outcome - How the turn ended.
   * @param error - Why it failed.
   */
  finish(outcome: string, error?: string | null): void {
    if (this.finished) return;
    if (error) this.turnSpan.fail(error);
    this.turnSpan.end({ "hypotenuse.outcome": outcome });
    this.finished = true;
  }
}
