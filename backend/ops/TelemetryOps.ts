import { AsyncLocalStorage } from "node:async_hooks";
import {
  attributes,
  type ClaimTelemetry,
  type ContentLevel,
  formatTraceparent,
  type KeyValue,
  type LogsRequest,
  levelRank,
  type MetricsRequest,
  maxLevel,
  minLevel,
  newSpanId,
  type OtlpMetric,
  type OtlpSignal,
  type OtlpSpan,
  parseTraceparent,
  SEVERITY,
  SPAN_KIND,
  STATUS_CODE,
  sampledBy,
  TEMPORALITY,
  type TelemetryCapability,
  type TracesRequest,
  unixNano,
} from "@hypotenuse/protocol";
import { and, asc, count, eq, lte } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../schema/agent_sessions";
import { runners } from "../schema/runners";
import {
  type TelemetryExporter,
  telemetryExporters,
} from "../schema/telemetry_exporters";
import {
  type WorkItem,
  type WorkItemTelemetry,
  workItems,
} from "../schema/work_items";
import { enqueueTelemetry } from "./TelemetryRelayOps";

/**
 * The server's half of a project's telemetry: what it observes about the
 * project's work, emitted as OTLP into the project's relay stream, and the
 * decision the claim hands a daemon about what to collect.
 *
 * Nothing here runs for a project with no enabled exporter — the check is a
 * lookup cached for a few seconds per process ({@link projectTelemetry}),
 * dropped at once by the exporter actions in the process that changed it.
 *
 * Spans are not an in-process OpenTelemetry SDK's. A turn's trace spans
 * three processes and days of wall time, so every server span is built
 * explicitly from what the database already knows — a work item's
 * `traceparent` names its trace and root span — and written when it ends.
 * Code that calls Linear on a turn's behalf runs inside a {@link TraceScope}
 * (`AsyncLocalStorage`), which is how a GraphQL request finds its parent.
 *
 * Spans are built from serializers and operation names, never from request
 * headers or tokens; free text (a person's prompt) goes under
 * `hypotenuse.content.*`, which an exporter below `content` never receives.
 */

/** How long a project's exporter lookup is trusted. */
const CACHE_MS = 5_000;

/** What a process needs to know about a project's exporters. */
export interface ProjectTelemetry {
  projectId: number;
  /** Its enabled exporters. */
  exporters: TelemetryExporter[];
  /** The highest content level any of them wants. */
  maxContent: ContentLevel;
  /** The highest trace sample ratio among those that take traces or logs. */
  maxRatio: number;
  /** Whether any of them captures the agent's own telemetry. */
  agentNative: boolean;
  /** The signals at least one of them takes. */
  signals: Set<OtlpSignal>;
}

/** Project id → its lookup, and when it was made. */
const cache = new Map<number, { at: number; value: ProjectTelemetry | null }>();

/**
 * A project's telemetry, or null when it has no enabled exporter.
 * @param projectId - The project.
 * @returns The lookup.
 */
export async function projectTelemetry(
  projectId: number,
): Promise<ProjectTelemetry | null> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const rows = await api.db.db
    .select()
    .from(telemetryExporters)
    .where(
      and(
        eq(telemetryExporters.projectId, projectId),
        eq(telemetryExporters.enabled, true),
      ),
    )
    .orderBy(asc(telemetryExporters.id));
  const value = rows.length ? summarize(projectId, rows) : null;
  cache.set(projectId, { at: Date.now(), value });
  return value;
}

/**
 * Summarize a project's enabled exporters.
 * @param projectId - The project.
 * @param rows - The exporters.
 * @returns The summary.
 */
function summarize(
  projectId: number,
  rows: TelemetryExporter[],
): ProjectTelemetry {
  const sampling = rows.filter(
    (r) => r.signals.includes("traces") || r.signals.includes("logs"),
  );
  return {
    projectId,
    exporters: rows,
    maxContent: maxLevel(rows.map((r) => r.content)),
    maxRatio: Math.max(0, ...sampling.map((r) => r.traceSampleRatio)),
    agentNative: rows.some((r) => r.agentNative),
    signals: new Set(rows.flatMap((r) => r.signals)),
  };
}

/**
 * Drop a project's cached lookup (after its exporters change).
 * @param projectId - The project, or undefined for every project.
 */
export function forgetProjectTelemetry(projectId?: number): void {
  if (projectId === undefined) cache.clear();
  else cache.delete(projectId);
}

/** Where code that calls Linear on a turn's behalf is, in its trace. */
export interface TraceScope {
  projectId: number;
  traceId: string;
  /** The span a client span started now is a child of. */
  parentSpanId: string;
}

/** The current trace scope, if any. */
const scopes = new AsyncLocalStorage<TraceScope>();

/**
 * Run work inside a trace scope.
 * @param scope - The scope, or null to run outside any.
 * @param fn - The work.
 * @returns What it returns.
 */
export function withTraceScope<T>(
  scope: TraceScope | null,
  fn: () => Promise<T>,
): Promise<T> {
  return scope ? scopes.run(scope, fn) : fn();
}

/** @returns The scope the caller runs in, if any. */
export function currentTraceScope(): TraceScope | undefined {
  return scopes.getStore();
}

/** An attribute value. */
type Scalar = string | number | boolean | null | undefined;

/** A span the server observed, as its emitter describes it. */
export interface ServerSpan {
  name: string;
  traceId: string;
  /** Minted when absent. */
  spanId?: string;
  /** The parent; absent for a root span. */
  parentSpanId?: string | null;
  kind?: keyof typeof SPAN_KIND;
  startMs: number;
  endMs: number;
  attributes?: Record<string, Scalar>;
  events?: {
    name: string;
    atMs: number;
    attributes?: Record<string, Scalar>;
  }[];
  /** `error` with a message for a failure. */
  error?: string | null;
}

/** The scope every server span is written under. */
const SCOPE = { name: "hypotenuse.server", version: "1" };

/**
 * The resource of the server's own telemetry for a project.
 * @param projectId - The project.
 * @param extra - Turn attributes, when the batch is one turn's.
 * @returns The resource attributes.
 */
function serverResource(
  projectId: number,
  extra: Record<string, Scalar> = {},
): KeyValue[] {
  return attributes({
    "service.name": "hypotenuse-server",
    "service.namespace": "hypotenuse",
    "hypotenuse.source": "server",
    "hypotenuse.project.id": projectId,
    ...extra,
  });
}

/**
 * One span as OTLP.
 * @param span - The span.
 * @returns The OTLP span.
 */
function toOtlpSpan(span: ServerSpan): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId ?? newSpanId(),
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND[span.kind ?? "internal"],
    startTimeUnixNano: unixNano(span.startMs),
    endTimeUnixNano: unixNano(Math.max(span.endMs, span.startMs)),
    attributes: attributes(span.attributes ?? {}),
    events: (span.events ?? []).map((e) => ({
      name: e.name,
      timeUnixNano: unixNano(e.atMs),
      attributes: attributes(e.attributes ?? {}),
    })),
    status: span.error
      ? { code: STATUS_CODE.error, message: span.error.slice(0, 1024) }
      : { code: STATUS_CODE.unset },
  };
}

/**
 * Write spans to a project's relay stream, if anything exports them. Never
 * throws: telemetry never fails the work it describes.
 * @param projectId - The project.
 * @param spans - The spans, all of one trace.
 * @param resource - Extra resource attributes (a turn's).
 */
export async function emitSpans(
  projectId: number,
  spans: ServerSpan[],
  resource: Record<string, Scalar> = {},
): Promise<void> {
  if (spans.length === 0) return;
  try {
    const pt = await projectTelemetry(projectId);
    if (!pt?.signals.has("traces")) return;
    const request: TracesRequest = {
      resourceSpans: [
        {
          resource: { attributes: serverResource(projectId, resource) },
          scopeSpans: [{ scope: SCOPE, spans: spans.map(toOtlpSpan) }],
        },
      ],
    };
    await enqueueTelemetry(projectId, "traces", request, spans[0]?.traceId);
  } catch (error) {
    warn("emitting spans", error);
  }
}

/** A log record the server observed. */
export interface ServerLog {
  atMs: number;
  severity?: keyof typeof SEVERITY;
  body: string;
  eventName?: string;
  attributes?: Record<string, Scalar>;
  traceId?: string;
  spanId?: string;
}

/**
 * Write log records to a project's relay stream, if anything exports logs.
 * @param projectId - The project.
 * @param records - The records.
 */
export async function emitLogs(
  projectId: number,
  records: ServerLog[],
): Promise<void> {
  if (records.length === 0) return;
  try {
    const pt = await projectTelemetry(projectId);
    if (!pt?.signals.has("logs")) return;
    const request: LogsRequest = {
      resourceLogs: [
        {
          resource: { attributes: serverResource(projectId) },
          scopeLogs: [
            {
              scope: SCOPE,
              logRecords: records.map((r) => ({
                timeUnixNano: unixNano(r.atMs),
                observedTimeUnixNano: unixNano(Date.now()),
                severityNumber: SEVERITY[r.severity ?? "info"],
                severityText: (r.severity ?? "info").toUpperCase(),
                body: { stringValue: r.body },
                ...(r.eventName ? { eventName: r.eventName } : {}),
                attributes: attributes(r.attributes ?? {}),
                ...(r.traceId ? { traceId: r.traceId } : {}),
                ...(r.spanId ? { spanId: r.spanId } : {}),
              })),
            },
          ],
        },
      ],
    };
    await enqueueTelemetry(
      projectId,
      "logs",
      request,
      records.length === 1 ? records[0]?.traceId : undefined,
    );
  } catch (error) {
    warn("emitting logs", error);
  }
}

/**
 * Log a telemetry failure, which is never more than a warning.
 * @param what - What was being done.
 * @param error - What went wrong.
 */
function warn(what: string, error: unknown): void {
  api.logger.warn(`telemetry: ${what} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Histogram bucket bounds for durations, in ms. */
const DURATION_BOUNDS = [
  10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

/** One aggregated series. */
interface Series {
  name: string;
  unit: string;
  description: string;
  kind: "sum" | "histogram" | "gauge";
  attrs: Record<string, Scalar>;
  value: number;
  count: number;
  buckets: number[];
  min: number;
  max: number;
}

/** Project id → series key → series, since the last flush. */
const series = new Map<number, Map<string, Series>>();

/** When the series were last flushed. */
let lastFlush = Date.now();

/** The flush timer, started by the first recorded value. */
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** How often aggregated metrics are flushed to the streams. */
const FLUSH_MS = 5_000;

/**
 * The series for a name and attributes, created on first use.
 * @param projectId - The project.
 * @param init - The series' identity.
 * @returns The series.
 */
function seriesFor(
  projectId: number,
  init: Pick<Series, "name" | "unit" | "description" | "kind" | "attrs">,
): Series {
  if (!flushTimer) {
    flushTimer = setInterval(() => void flushServerMetrics(), FLUSH_MS);
    flushTimer.unref?.();
  }
  const key = `${init.name}|${JSON.stringify(init.attrs)}`;
  let byKey = series.get(projectId);
  if (!byKey) {
    byKey = new Map();
    series.set(projectId, byKey);
  }
  let s = byKey.get(key);
  if (!s) {
    s = {
      ...init,
      value: 0,
      count: 0,
      buckets: new Array(DURATION_BOUNDS.length + 1).fill(0),
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    byKey.set(key, s);
  }
  return s;
}

/**
 * Add to a counter, for a project with an exporter that takes metrics.
 * @param projectId - The project.
 * @param name - The metric.
 * @param attrs - Its attributes.
 * @param value - How much.
 */
export async function countMetric(
  projectId: number,
  name: string,
  attrs: Record<string, Scalar>,
  value = 1,
): Promise<void> {
  const pt = await projectTelemetry(projectId).catch(() => null);
  if (!pt?.signals.has("metrics")) return;
  seriesFor(projectId, {
    name,
    unit: "{request}",
    description: "",
    kind: "sum",
    attrs,
  }).value += value;
}

/**
 * Record a duration in a histogram, for a project whose exporters take metrics.
 * @param projectId - The project.
 * @param name - The metric.
 * @param ms - The duration.
 * @param attrs - Its attributes.
 */
export async function recordDuration(
  projectId: number,
  name: string,
  ms: number,
  attrs: Record<string, Scalar> = {},
): Promise<void> {
  const pt = await projectTelemetry(projectId).catch(() => null);
  if (!pt?.signals.has("metrics")) return;
  const s = seriesFor(projectId, {
    name,
    unit: "ms",
    description: "",
    kind: "histogram",
    attrs,
  });
  s.count++;
  s.value += ms;
  s.min = Math.min(s.min, ms);
  s.max = Math.max(s.max, ms);
  const bucket = DURATION_BOUNDS.findIndex((b) => ms <= b);
  s.buckets[bucket === -1 ? DURATION_BOUNDS.length : bucket]++;
}

/**
 * Set a gauge, for a project whose exporters take metrics.
 * @param projectId - The project.
 * @param name - The metric.
 * @param value - The value now.
 * @param attrs - Its attributes.
 */
export async function setGauge(
  projectId: number,
  name: string,
  value: number,
  attrs: Record<string, Scalar> = {},
): Promise<void> {
  const pt = await projectTelemetry(projectId).catch(() => null);
  if (!pt?.signals.has("metrics")) return;
  seriesFor(projectId, {
    name,
    unit: "{runner}",
    description: "",
    kind: "gauge",
    attrs,
  }).value = value;
}

/**
 * Write every project's aggregated metrics to its stream as one delta batch,
 * and start new intervals.
 */
export async function flushServerMetrics(): Promise<void> {
  const start = lastFlush;
  const now = Date.now();
  lastFlush = now;
  const drained = [...series.entries()];
  series.clear();
  for (const [projectId, byKey] of drained) {
    const metrics: OtlpMetric[] = [];
    for (const s of byKey.values()) {
      const point = {
        attributes: attributes(s.attrs),
        startTimeUnixNano: unixNano(start),
        timeUnixNano: unixNano(now),
      };
      if (s.kind === "sum") {
        metrics.push({
          name: s.name,
          unit: s.unit,
          sum: {
            aggregationTemporality: TEMPORALITY.delta,
            isMonotonic: true,
            dataPoints: [{ ...point, asInt: String(Math.round(s.value)) }],
          },
        });
      } else if (s.kind === "gauge") {
        metrics.push({
          name: s.name,
          unit: s.unit,
          gauge: { dataPoints: [{ ...point, asInt: String(s.value) }] },
        });
      } else {
        metrics.push({
          name: s.name,
          unit: s.unit,
          histogram: {
            aggregationTemporality: TEMPORALITY.delta,
            dataPoints: [
              {
                ...point,
                count: String(s.count),
                sum: s.value,
                bucketCounts: s.buckets.map(String),
                explicitBounds: DURATION_BOUNDS,
                min: s.min,
                max: s.max,
              },
            ],
          },
        });
      }
    }
    if (metrics.length === 0) continue;
    const request: MetricsRequest = {
      resourceMetrics: [
        {
          resource: { attributes: serverResource(projectId) },
          scopeMetrics: [{ scope: SCOPE, metrics }],
        },
      ],
    };
    try {
      await enqueueTelemetry(projectId, "metrics", request);
    } catch (error) {
      warn("flushing metrics", error);
    }
  }
}

/**
 * Set each telemetry project's runner gauge: how many of its runners are
 * online, draining, and offline right now. Run by the export clock, so the
 * gauge has a point in every interval.
 * @param projectIds - The projects to measure (default: every one with an
 *   enabled exporter).
 */
export async function recordRunnerGauges(projectIds?: number[]): Promise<void> {
  try {
    const ids =
      projectIds ??
      (
        await api.db.db
          .selectDistinct({ projectId: telemetryExporters.projectId })
          .from(telemetryExporters)
          .where(eq(telemetryExporters.enabled, true))
      ).map((r) => r.projectId);
    for (const projectId of ids) {
      const rows = await api.db.db
        .select({ status: runners.status, n: count() })
        .from(runners)
        .where(eq(runners.projectId, projectId))
        .groupBy(runners.status);
      for (const status of ["online", "draining", "offline"] as const) {
        await setGauge(
          projectId,
          "hypotenuse.runners.online",
          Number(rows.find((r) => r.status === status)?.n ?? 0),
          { "hypotenuse.runner.status": status },
        );
      }
    }
  } catch (error) {
    warn("measuring runners", error);
  }
}

/**
 * A turn's trace: its id and the id of its root `turn` span.
 * @param item - The work item.
 * @returns The trace id and root span id.
 */
export function turnTrace(item: Pick<WorkItem, "traceparent">): {
  traceId: string;
  rootSpanId: string;
} {
  const ctx = parseTraceparent(item.traceparent);
  // Every row is written with a valid one; a hand-edited row gets no trace.
  return {
    traceId: ctx?.traceId ?? "0".repeat(32),
    rootSpanId: ctx?.spanId ?? "0".repeat(16),
  };
}

/**
 * A span of a turn, directly under its root unless a parent is given.
 * @param item - The work item.
 * @param span - The span, without its trace.
 * @returns The span in the turn's trace.
 */
export function turnSpan(
  item: Pick<WorkItem, "traceparent">,
  span: Omit<ServerSpan, "traceId" | "parentSpanId"> & {
    parentSpanId?: string | null;
  },
): ServerSpan {
  const { traceId, rootSpanId } = turnTrace(item);
  return { ...span, traceId, parentSpanId: span.parentSpanId ?? rootSpanId };
}

/** A span queued by a transaction for after its commit. */
export interface PendingSpan {
  projectId: number;
  span: ServerSpan;
}

/**
 * Emit what transactions queued, grouped by project.
 * @param pending - The spans.
 */
export async function emitPendingSpans(pending: PendingSpan[]): Promise<void> {
  const byProject = new Map<number, ServerSpan[]>();
  for (const p of pending) {
    const list = byProject.get(p.projectId) ?? [];
    list.push(p.span);
    byProject.set(p.projectId, list);
  }
  for (const [projectId, spans] of byProject) {
    // One batch per trace, so the relay samples each whole.
    const byTrace = new Map<string, ServerSpan[]>();
    for (const s of spans) {
      const list = byTrace.get(s.traceId) ?? [];
      list.push(s);
      byTrace.set(s.traceId, list);
    }
    for (const group of byTrace.values()) await emitSpans(projectId, group);
  }
}

/**
 * Emit a finished turn's root `turn` span, carrying the turn's attributes —
 * every resource and root span names the project, session, turn, role,
 * runner, agent, repository, and the Linear issue and session.
 * @param workItemId - The turn, already terminal.
 */
export async function emitTurnSpan(workItemId: number): Promise<void> {
  try {
    const [row] = await api.db.db
      .select({ item: workItems, session: agentSessions, runner: runners })
      .from(workItems)
      .innerJoin(agentSessions, eq(agentSessions.id, workItems.agentSessionId))
      .leftJoin(runners, eq(runners.id, workItems.runnerId))
      .where(eq(workItems.id, workItemId));
    if (!row || !(await projectTelemetry(row.item.projectId))) return;
    const { item, session, runner } = row;
    const [{ ordinal }] = await api.db.db
      .select({ ordinal: count() })
      .from(workItems)
      .where(
        and(
          eq(workItems.agentSessionId, item.agentSessionId),
          lte(workItems.id, item.id),
        ),
      );
    const attrs = turnAttributes(item, session, runner, Number(ordinal));
    const { traceId, rootSpanId } = turnTrace(item);
    const failed = item.status === "failed" || item.status === "expired";
    await emitSpans(
      item.projectId,
      [
        {
          name: "turn",
          traceId,
          spanId: rootSpanId,
          kind: "server",
          startMs: item.createdAt.getTime(),
          endMs: (item.finishedAt ?? new Date()).getTime(),
          attributes: {
            ...attrs,
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": item.agentId,
            "hypotenuse.work_item.kind": item.kind,
            "hypotenuse.work_item.status": item.status,
            "hypotenuse.work_item.attempts": item.attempts,
            "hypotenuse.cancel_reason": item.cancelReason,
            "hypotenuse.telemetry.note": item.telemetry?.note ?? null,
            "gen_ai.usage.input_tokens": item.usage?.inputTokens,
            "gen_ai.usage.output_tokens": item.usage?.outputTokens,
            "hypotenuse.usage.cost_usd": item.usage?.costUsd,
            "hypotenuse.linear_writes": item.linearWrites.length,
            "hypotenuse.queue.wait_ms": item.claimedAt
              ? item.claimedAt.getTime() - item.queuedAt.getTime()
              : null,
          },
          error: failed
            ? (item.outcome?.error ?? `the turn ${item.status}`)
            : null,
        },
      ],
      attrs,
    );
  } catch (error) {
    warn("emitting a turn span", error);
  }
}

/**
 * The attributes every resource and root span of a turn carries.
 * @param item - The work item.
 * @param session - Its session.
 * @param runner - The runner that held it, if any.
 * @param ordinal - Which turn of the session it is, from 1.
 * @returns The attributes.
 */
export function turnAttributes(
  item: WorkItem,
  session: typeof agentSessions.$inferSelect,
  runner: {
    id: number;
    name: string;
    agents: { id: string; preset: string }[];
  } | null,
  ordinal?: number,
): Record<string, Scalar> {
  return {
    "hypotenuse.project.id": item.projectId,
    "hypotenuse.session.id": item.agentSessionId,
    "hypotenuse.work_item.id": item.id,
    "hypotenuse.turn": ordinal,
    "hypotenuse.role": item.role,
    "hypotenuse.runner.id": runner?.id,
    "hypotenuse.runner.name": runner?.name,
    "hypotenuse.agent.id": item.agentId,
    "hypotenuse.agent.preset":
      runner?.agents.find((a) => a.id === item.agentId)?.preset ?? null,
    "hypotenuse.repository": item.repository,
    "linear.issue.identifier": session.issueIdentifier,
    "linear.agent_session.id": session.externalSessionId,
    "linear.team.key": session.teamKey,
  };
}

/** What the claim hands the daemon and records on the item. */
export interface ClaimTelemetryDecision {
  claim: ClaimTelemetry | null;
  record: WorkItemTelemetry | null;
}

/**
 * Decide a turn's telemetry at claim: what the project's exporters want,
 * lowered to what the runner's owner allows. Every combination of the two is
 * one row of this table, and each is tested:
 *
 * | Exporters want | Runner allows | Collected | Note |
 * |---|---|---|---|
 * | none enabled | anything | nothing (claim null) | — |
 * | level L, native | enabled, cap ≥ L, native | L + native | — |
 * | level L, native | enabled, cap < L | the cap | capped at the cap |
 * | level L, native | enabled, native off | L, no native | native disabled |
 * | level L, no native | enabled | L (capped), no native | (capped, if so) |
 * | anything | disabled, or reports no cap | nothing (claim null) | sends no telemetry |
 *
 * The sampled flag says whether **any** exporter keeps the turn: its trace
 * id's sample number is below the highest ratio. Each exporter's own ratio
 * is applied again at export, so a turn is kept or dropped whole per exporter.
 * @param pt - The project's telemetry (null: nothing exported).
 * @param item - The work item being claimed.
 * @param runner - The claiming runner's name and reported cap.
 * @returns The claim's field and the item's record.
 */
export function decideClaimTelemetry(
  pt: ProjectTelemetry | null,
  item: Pick<WorkItem, "traceparent">,
  runner: { name: string; telemetry: TelemetryCapability | null },
): ClaimTelemetryDecision {
  if (!pt) return { claim: null, record: null };
  const { traceId, rootSpanId } = turnTrace(item);
  const sampled = sampledBy(traceId, pt.maxRatio) && pt.maxRatio > 0;
  const cap = runner.telemetry;
  if (!cap?.enabled) {
    return {
      claim: null,
      record: {
        content: null,
        agentNative: false,
        sampled,
        note: `runner \`${runner.name}\` sends no telemetry`,
      },
    };
  }
  const content = minLevel(pt.maxContent, cap.maxContent);
  const notes: string[] = [];
  if (levelRank(cap.maxContent) < levelRank(pt.maxContent))
    notes.push(
      `telemetry capped at \`${cap.maxContent}\` by runner \`${runner.name}\``,
    );
  if (pt.agentNative && !cap.agentNative)
    notes.push(`native agent telemetry disabled on runner \`${runner.name}\``);
  const agentNative = pt.agentNative && cap.agentNative;
  return {
    claim: {
      traceparent: formatTraceparent({ traceId, spanId: rootSpanId, sampled }),
      sampled,
      content,
      agentNative,
    },
    record: {
      content,
      agentNative,
      sampled,
      note: notes.length ? notes.join("; ") : null,
    },
  };
}
