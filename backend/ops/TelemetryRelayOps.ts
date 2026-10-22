import { gunzipSync } from "node:zlib";
import {
  attributes,
  decodeOtlpBody,
  encodeOtlpProtobuf,
  filterForLevel,
  type KeyValue,
  type LogsRequest,
  MAX_TELEMETRY_BODY_BYTES,
  MAX_TELEMETRY_INFLATED_BYTES,
  type MetricsRequest,
  mergeRequests,
  NOT_YOUR_WORK,
  OTLP_CONTENT_TYPES,
  OTLP_SIGNALS,
  type OtlpRequestBySignal,
  type OtlpSignal,
  parseTraceparent,
  recordCount,
  redactOtlp,
  SPAN_KIND,
  sampledBy,
  stampResource,
  TELEMETRY_LATE,
  TELEMETRY_NOT_WANTED,
  TELEMETRY_RATE_LIMITED,
  TELEMETRY_SIGNAL_HEADER,
  TELEMETRY_WORK_ITEM_HEADER,
  TRACEPARENT_HEADER,
  type TracesRequest,
  unixNano,
} from "@hypotenuse/protocol";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, for `config.telemetry` (see `CryptoOps.ts`).
import type {} from "../config/telemetry";
import type { Runner } from "../schema/runners";
import {
  type TelemetryExporter,
  telemetryExporters,
} from "../schema/telemetry_exporters";
import { TERMINAL_WORK_STATUSES, workItems } from "../schema/work_items";
import { SENSITIVE_KEYS } from "./AuditOps";
import { endpointRefusal } from "./EndpointSafetyOps";
import { readCappedBody } from "./RawRequestOps";
import { runRedisScript } from "./RedisScriptOps";
import { openHeaders } from "./TelemetryExporterOps";
import {
  flushServerMetrics,
  projectTelemetry,
  recordRunnerGauges,
} from "./TelemetryOps";

/**
 * The relay: how a project's telemetry gets from whoever observed it — the
 * daemon on a runner, the agent it runs, the server itself — to each of the
 * project's collectors, without a collector credential ever leaving the
 * server or a collector ever being called inline.
 *
 * **In.** Everything is an OTLP/JSON batch of one signal, appended to the
 * project's Redis stream (`telemetry:stream:<projectId>`, capped in length,
 * expiring an hour after its last entry). The daemon's batches arrive through
 * `daemon:telemetry` ({@link acceptDaemonTelemetry}), which checks the turn,
 * the late window, and the project's byte rate, then answers 202.
 *
 * **Out.** The `telemetry:export` clock ({@link exportAll}) reads each
 * project's stream once **per exporter**, through a consumer group of its
 * own, so one collector that is down never holds up another: its unacked
 * entries stay pending, are read again after its backoff, and are lost only
 * when the stream's length or age passes them. Each entry is filtered for
 * the exporter — its signals, its share of traces (one sample number per
 * trace id), its content level, whether it takes the agent's own telemetry —
 * redacted again, stamped with its resource attributes, encoded in its
 * protocol, and POSTed gzipped with its headers. `429` and `5xx` retry,
 * honouring `Retry-After`; any other refusal drops the batch. Either way the
 * row's `lastError` says what happened, and an exporter is never disabled.
 */

/** The set of projects whose streams have had entries. */
const PROJECTS_KEY = "telemetry:projects";

/**
 * A project's stream.
 * @param projectId - The project.
 * @returns The key.
 */
export function streamKey(projectId: number): string {
  return `telemetry:stream:${projectId}`;
}

/**
 * An exporter's consumer group.
 * @param exporterId - The exporter.
 * @returns The group name.
 */
function groupName(exporterId: number): string {
  return `exporter:${exporterId}`;
}

/**
 * An exporter's backoff key: present while it must not be tried.
 * @param exporterId - The exporter.
 * @returns The key.
 */
function backoffKey(exporterId: number): string {
  return `telemetry:backoff:${exporterId}`;
}

/**
 * An exporter's consecutive failure count.
 * @param exporterId - The exporter.
 * @returns The key.
 */
function failuresKey(exporterId: number): string {
  return `telemetry:failures:${exporterId}`;
}

/**
 * Append a batch to a project's stream.
 * @param projectId - The project.
 * @param signal - The batch's signal.
 * @param request - The batch, OTLP/JSON.
 * @param traceId - The trace it belongs to, which sampling decides it by;
 *   absent for metrics and for batches of no one trace.
 */
export async function enqueueTelemetry<S extends OtlpSignal>(
  projectId: number,
  signal: S,
  request: OtlpRequestBySignal[S],
  traceId?: string,
): Promise<void> {
  const key = streamKey(projectId);
  const redis = api.redis.redis;
  await redis.xadd(
    key,
    "MAXLEN",
    "~",
    String(config.telemetry.streamMaxLength),
    "*",
    "s",
    signal,
    "t",
    traceId ?? "",
    "b",
    JSON.stringify(request),
  );
  await redis.pexpire(key, config.telemetry.streamTtlMs);
  await redis.sadd(PROJECTS_KEY, String(projectId));
}

/**
 * Give a new exporter its consumer group, reading from now on: it receives
 * what is observed after it was created, not the stream's backlog.
 * @param projectId - The project.
 * @param exporterId - The exporter.
 * @param from - `$` for new entries only, `0` for everything in the stream.
 */
export async function ensureExporterGroup(
  projectId: number,
  exporterId: number,
  from: "$" | "0" = "$",
): Promise<void> {
  try {
    await api.redis.redis.xgroup(
      "CREATE",
      streamKey(projectId),
      groupName(exporterId),
      from,
      "MKSTREAM",
    );
    await api.redis.redis.pexpire(
      streamKey(projectId),
      config.telemetry.streamTtlMs,
    );
  } catch (error) {
    if (!String(error).includes("BUSYGROUP")) throw error;
  }
}

/**
 * Remove a deleted exporter's group and backoff.
 * @param projectId - The project.
 * @param exporterId - The exporter.
 */
export async function dropExporterGroup(
  projectId: number,
  exporterId: number,
): Promise<void> {
  await api.redis.redis
    .xgroup("DESTROY", streamKey(projectId), groupName(exporterId))
    .catch(() => 0);
  await api.redis.redis.del(backoffKey(exporterId), failuresKey(exporterId));
}

/** What a collector said to one POST. */
export interface PostOutcome {
  ok: boolean;
  /** The HTTP status, or 0 when no answer came. */
  status: number;
  /** Whether to retry (429, 5xx, no answer). */
  retryable: boolean;
  /** `Retry-After`, in ms. */
  retryAfterMs: number | null;
  /** A sentence for `lastError`. */
  error: string | null;
}

/**
 * Read `Retry-After`.
 * @param value - Seconds, or an HTTP date.
 * @returns Milliseconds, or null.
 */
function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * POST one request to an exporter's collector: the signal's path, its
 * encoding, gzipped, with its headers. Checks the endpoint first — the host
 * is resolved again on every export.
 * @param exporter - The exporter.
 * @param signal - The signal.
 * @param request - OTLP/JSON, already filtered for it.
 * @returns What happened.
 */
export async function postOtlp<S extends OtlpSignal>(
  exporter: TelemetryExporter,
  signal: S,
  request: OtlpRequestBySignal[S],
): Promise<PostOutcome> {
  const refusal = await endpointRefusal(exporter.endpoint);
  if (refusal)
    return {
      ok: false,
      status: 0,
      retryable: false,
      retryAfterMs: null,
      error: refusal,
    };
  const body =
    exporter.protocol === "http/json"
      ? new TextEncoder().encode(JSON.stringify(request))
      : encodeOtlpProtobuf(signal, request);
  let response: Response;
  try {
    response = await fetch(`${exporter.endpoint}/v1/${signal}`, {
      method: "POST",
      headers: {
        ...openHeaders(exporter),
        "Content-Type": OTLP_CONTENT_TYPES[exporter.protocol],
        "Content-Encoding": "gzip",
        "User-Agent": "hypotenuse-relay",
      },
      body: Bun.gzipSync(new Uint8Array(body)),
      redirect: "manual",
      signal: AbortSignal.timeout(config.telemetry.exportTimeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      retryable: true,
      retryAfterMs: null,
      error: `The collector did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Read and discard: the answer is a partial-success message at most.
  await response.arrayBuffer().catch(() => null);
  if (response.ok)
    return {
      ok: true,
      status: response.status,
      retryable: false,
      retryAfterMs: null,
      error: null,
    };
  const retryable = response.status === 429 || response.status >= 500;
  return {
    ok: false,
    status: response.status,
    retryable,
    retryAfterMs: retryable
      ? retryAfter(response.headers.get("retry-after"))
      : null,
    error: `The collector answered ${response.status} to ${signal}.`,
  };
}

/** One stream entry. */
interface Entry {
  id: string;
  signal: OtlpSignal;
  traceId: string;
  body: OtlpRequestBySignal[OtlpSignal];
}

/**
 * Parse XREADGROUP's answer.
 * @param reply - `[[key, [[id, [field, value, …]] | [id, null], …]]]`.
 * @returns The entries, and the ids of entries the stream already trimmed.
 */
function parseEntries(reply: unknown): { entries: Entry[]; gone: string[] } {
  const entries: Entry[] = [];
  const gone: string[] = [];
  const streams = (reply ?? []) as [string, [string, string[] | null][]][];
  for (const [, items] of streams) {
    for (const [id, fields] of items) {
      if (!fields) {
        gone.push(id);
        continue;
      }
      const f: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2)
        f[fields[i]] = fields[i + 1];
      try {
        const signal = f.s as OtlpSignal;
        if (!(OTLP_SIGNALS as readonly string[]).includes(signal))
          throw new Error("signal");
        entries.push({
          id,
          signal,
          traceId: f.t ?? "",
          body: JSON.parse(f.b ?? "{}"),
        });
      } catch {
        gone.push(id);
      }
    }
  }
  return { entries, gone };
}

/**
 * Drop resource groups the agent itself produced.
 * @param signal - The signal.
 * @param request - The request.
 * @returns The request without them.
 */
function withoutNative<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
): OtlpRequestBySignal[S] {
  const native = (attrs: KeyValue[] | undefined) =>
    attrs?.some(
      (a) =>
        a.key === "hypotenuse.source" &&
        a.value?.stringValue === "agent_native",
    ) ?? false;
  if (signal === "traces")
    return {
      resourceSpans: ((request as TracesRequest).resourceSpans ?? []).filter(
        (g) => !native(g.resource?.attributes),
      ),
    } as OtlpRequestBySignal[S];
  if (signal === "logs")
    return {
      resourceLogs: ((request as LogsRequest).resourceLogs ?? []).filter(
        (g) => !native(g.resource?.attributes),
      ),
    } as OtlpRequestBySignal[S];
  return {
    resourceMetrics: ((request as MetricsRequest).resourceMetrics ?? []).filter(
      (g) => !native(g.resource?.attributes),
    ),
  } as OtlpRequestBySignal[S];
}

/**
 * What one exporter receives of one entry: its signals, its share of the
 * entry's trace, its level, the agent's own telemetry if it takes it,
 * redacted, and stamped with its resource attributes. Null for nothing.
 * @param exporter - The exporter.
 * @param entry - The entry.
 * @param secrets - Every header value of the project's exporters.
 * @returns The request to send, or null.
 */
export function shapeForExporter(
  exporter: TelemetryExporter,
  entry: Pick<Entry, "signal" | "traceId" | "body">,
  secrets: string[],
): OtlpRequestBySignal[OtlpSignal] | null {
  const { signal } = entry;
  if (!exporter.signals.includes(signal)) return null;
  if (
    signal !== "metrics" &&
    entry.traceId &&
    !sampledBy(entry.traceId, exporter.traceSampleRatio)
  )
    return null;
  if (signal !== "metrics" && exporter.traceSampleRatio <= 0) return null;
  let body = filterForLevel(signal, entry.body, exporter.content);
  if (!exporter.agentNative) body = withoutNative(signal, body);
  if (recordCount(signal, body) === 0) return null;
  body = redactOtlp(body, { values: secrets, keys: SENSITIVE_KEYS });
  const extra = Object.entries(exporter.resourceAttributes).map(
    ([key, value]) => ({ key, value: { stringValue: value } }),
  );
  if (extra.length) body = stampResource(signal, body, extra);
  return body;
}

/** What one export pass did. */
export interface ExportReport {
  /** Exporter id → entries sent. */
  sent: Record<number, number>;
  /** Exporter id → entries dropped (refused or not retryable). */
  dropped: Record<number, number>;
  /** Exporter ids skipped for their backoff. */
  backedOff: number[];
}

/**
 * Every header value of a project's exporters — what redaction must never
 * let through to any collector, the exporter's own included.
 * @param exporters - The exporters.
 * @returns The values.
 */
function headerSecrets(exporters: TelemetryExporter[]): string[] {
  return exporters.flatMap((e) => {
    try {
      return Object.values(openHeaders(e));
    } catch {
      return [];
    }
  });
}

/**
 * Record an exporter's outcome on its row: the clock's write, unaudited like
 * every clock's.
 * @param exporterId - The exporter.
 * @param ok - Whether something was exported.
 * @param error - The sentence, when not.
 */
async function recordOutcome(
  exporterId: number,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await api.db.db
    .update(telemetryExporters)
    .set(
      ok
        ? { lastExportAt: new Date() }
        : { lastError: error, lastErrorAt: new Date() },
    )
    .where(eq(telemetryExporters.id, exporterId));
}

/**
 * Drain one exporter's share of a project's stream, in rounds, until it is
 * empty, the exporter backs off, or `maxRounds` pass.
 * @param exporter - The exporter.
 * @param secrets - The project's header values.
 * @param report - Accumulates what happened.
 * @param maxRounds - The most reads.
 */
async function exportFor(
  exporter: TelemetryExporter,
  secrets: string[],
  report: ExportReport,
  maxRounds = 20,
): Promise<void> {
  const redis = api.redis.redis;
  if ((await redis.pttl(backoffKey(exporter.id))) > 0) {
    report.backedOff.push(exporter.id);
    return;
  }
  const key = streamKey(exporter.projectId);
  const group = groupName(exporter.id);
  // A group is created at `$` when its exporter is; one missing now means
  // the stream expired with it, and everything in the new stream is unread.
  await ensureExporterGroup(exporter.projectId, exporter.id, "0");
  const count = String(config.telemetry.exportBatchEntries);
  for (let round = 0; round < maxRounds; round++) {
    // What failed last time first, then what is new.
    let parsed = parseEntries(
      await redis.xreadgroup(
        "GROUP",
        group,
        "relay",
        "COUNT",
        count,
        "STREAMS",
        key,
        "0",
      ),
    );
    if (parsed.entries.length === 0 && parsed.gone.length === 0)
      parsed = parseEntries(
        await redis.xreadgroup(
          "GROUP",
          group,
          "relay",
          "COUNT",
          count,
          "STREAMS",
          key,
          ">",
        ),
      );
    if (parsed.gone.length) await redis.xack(key, group, ...parsed.gone);
    if (parsed.entries.length === 0) return;

    const bySignal = new Map<
      OtlpSignal,
      { ids: string[]; bodies: unknown[] }
    >();
    for (const entry of parsed.entries) {
      const group_ = bySignal.get(entry.signal) ?? { ids: [], bodies: [] };
      group_.ids.push(entry.id);
      const shaped = shapeForExporter(exporter, entry, secrets);
      if (shaped) group_.bodies.push(shaped);
      bySignal.set(entry.signal, group_);
    }
    let failed: PostOutcome | null = null;
    for (const [signal, { ids, bodies }] of bySignal) {
      if (bodies.length === 0) {
        await redis.xack(key, group, ...ids);
        continue;
      }
      const outcome = await postOtlp(
        exporter,
        signal,
        mergeRequests(signal, bodies as OtlpRequestBySignal[typeof signal][]),
      );
      if (outcome.ok || !outcome.retryable) {
        await redis.xack(key, group, ...ids);
        if (outcome.ok)
          report.sent[exporter.id] =
            (report.sent[exporter.id] ?? 0) + ids.length;
        else
          report.dropped[exporter.id] =
            (report.dropped[exporter.id] ?? 0) + ids.length;
      }
      if (!outcome.ok) failed = outcome;
    }
    if (failed) {
      await recordOutcome(exporter.id, false, failed.error);
      api.logger.warn("telemetry export failed", {
        exporterId: exporter.id,
        status: failed.status,
        retryable: failed.retryable,
      });
      if (failed.retryable) {
        const failures = await redis.incr(failuresKey(exporter.id));
        await redis.pexpire(failuresKey(exporter.id), 3_600_000);
        const wait =
          failed.retryAfterMs ?? Math.min(1000 * 2 ** (failures - 1), 300_000);
        await redis.set(
          backoffKey(exporter.id),
          "1",
          "PX",
          Math.max(1, Math.ceil(wait)),
        );
        return;
      }
    } else {
      await redis.del(failuresKey(exporter.id));
      await recordOutcome(exporter.id, true, null);
    }
  }
}

/**
 * One pass of the `telemetry:export` clock: flush the server's own metrics,
 * then drain every project's stream to each of its enabled exporters.
 * @returns What happened, per exporter.
 */
export async function exportAll(): Promise<ExportReport> {
  await recordRunnerGauges();
  await flushServerMetrics();
  const report: ExportReport = { sent: {}, dropped: {}, backedOff: [] };
  const projectIds = (await api.redis.redis.smembers(PROJECTS_KEY)).map(Number);
  for (const projectId of projectIds) {
    if (!(await api.redis.redis.exists(streamKey(projectId)))) {
      await api.redis.redis.srem(PROJECTS_KEY, String(projectId));
      continue;
    }
    const exporters = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(
        and(
          eq(telemetryExporters.projectId, projectId),
          eq(telemetryExporters.enabled, true),
        ),
      );
    const secrets = headerSecrets(exporters);
    for (const exporter of exporters) {
      try {
        await exportFor(exporter, secrets, report);
      } catch (error) {
        api.logger.warn("telemetry export pass failed", {
          exporterId: exporter.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return report;
}

/** `daemon:telemetry`'s answer, as a status and a JSON body. */
export interface IngressAnswer {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * A refusal.
 * @param status - The HTTP status.
 * @param type - The `error.type`.
 * @param message - What went wrong.
 * @param headers - Extra headers.
 * @returns The answer.
 */
function refuse(
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
): IngressAnswer {
  return { status, body: { error: { type, message } }, headers };
}

/**
 * `daemon:telemetry`'s checks and its write. In order:
 *
 * 1. the signal header names a signal, and the body is under the cap (413);
 * 2. the work item exists and **this runner** claimed it (409 `NOT_YOUR_WORK`),
 *    and the `traceparent` names its trace — a runner writes only into the
 *    turns it held;
 * 3. the project has an enabled exporter (409 `TELEMETRY_NOT_WANTED`, and the
 *    daemon stops collecting for the turn);
 * 4. the turn is live, or finished less than `TELEMETRY_LATE_WINDOW` ago
 *    (410 `TELEMETRY_LATE`);
 * 5. the body inflates under its cap and decodes as OTLP (400);
 * 6. the project's byte budget has room (429 with `Retry-After`).
 *
 * Then every span and log record is pinned to the turn's trace — a record
 * naming another trace is dropped — the server stamps the resource
 * attributes it knows for itself (project, work item, runner), and the batch
 * goes onto the stream. 202; no collector is called inline.
 * @param runner - The runner, from its token.
 * @param request - The raw request.
 * @returns The answer.
 */
export async function acceptDaemonTelemetry(
  runner: Runner,
  request: Request,
): Promise<IngressAnswer> {
  const signal = request.headers.get(TELEMETRY_SIGNAL_HEADER)?.toLowerCase();
  if (!signal || !(OTLP_SIGNALS as readonly string[]).includes(signal))
    return refuse(
      400,
      "CONNECTION_ACTION_PARAM_VALIDATION",
      `${TELEMETRY_SIGNAL_HEADER} must be traces, metrics, or logs`,
    );
  const workItemId = Number(request.headers.get(TELEMETRY_WORK_ITEM_HEADER));
  if (!Number.isInteger(workItemId) || workItemId <= 0)
    return refuse(
      400,
      "CONNECTION_ACTION_PARAM_VALIDATION",
      `${TELEMETRY_WORK_ITEM_HEADER} must name a work item`,
    );
  const body = await readCappedBody(request, MAX_TELEMETRY_BODY_BYTES);
  if (body.oversized)
    return refuse(413, "CONNECTION_ACTION_PARAM_VALIDATION", "batch too large");

  const [item] = await api.db.db
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      runnerId: workItems.runnerId,
      traceparent: workItems.traceparent,
      status: workItems.status,
      finishedAt: workItems.finishedAt,
    })
    .from(workItems)
    .where(eq(workItems.id, workItemId));
  const trace = item ? parseTraceparent(item.traceparent) : null;
  const sent = parseTraceparent(request.headers.get(TRACEPARENT_HEADER));
  if (
    !item ||
    !trace ||
    item.runnerId !== runner.id ||
    item.projectId !== runner.projectId ||
    sent?.traceId !== trace.traceId
  )
    return refuse(
      409,
      NOT_YOUR_WORK,
      `work item ${workItemId} is not a turn this runner holds`,
    );
  if (!(await projectTelemetry(item.projectId)))
    return refuse(
      409,
      TELEMETRY_NOT_WANTED,
      "nothing exports this project's telemetry",
    );
  const terminal = (TERMINAL_WORK_STATUSES as readonly string[]).includes(
    item.status,
  );
  if (
    terminal &&
    item.finishedAt &&
    Date.now() - item.finishedAt.getTime() > config.telemetry.lateWindowMs
  )
    return refuse(
      410,
      TELEMETRY_LATE,
      "the turn finished longer ago than the late window",
    );

  let bytes = body.bytes;
  if ((request.headers.get("content-encoding") ?? "").includes("gzip")) {
    try {
      bytes = gunzipSync(bytes, {
        maxOutputLength: MAX_TELEMETRY_INFLATED_BYTES,
      });
    } catch {
      return refuse(
        400,
        "CONNECTION_ACTION_PARAM_VALIDATION",
        "the body is not gzip, or inflates past the cap",
      );
    }
  }
  let otlp: OtlpRequestBySignal[OtlpSignal];
  try {
    otlp = decodeOtlpBody(
      signal as OtlpSignal,
      bytes,
      request.headers.get("content-type"),
    );
  } catch {
    return refuse(
      400,
      "CONNECTION_ACTION_PARAM_VALIDATION",
      "the body is not an OTLP request",
    );
  }

  const [granted, waitMs] = (await runRedisScript(
    "telemetry-byte-bucket",
    [`telemetry:bucket:${item.projectId}`],
    [
      Date.now(),
      config.telemetry.projectBytesPerSecond,
      config.telemetry.projectBurstBytes,
      bytes.byteLength,
    ],
  )) as [number, number];
  if (!granted)
    return refuse(
      429,
      TELEMETRY_RATE_LIMITED,
      "the project's telemetry budget is spent",
      { "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))) },
    );

  const pinned = pinToTrace(signal as OtlpSignal, otlp, trace.traceId);
  stampResource(
    signal as OtlpSignal,
    pinned,
    attributes({
      "hypotenuse.project.id": item.projectId,
      "hypotenuse.work_item.id": item.id,
      "hypotenuse.runner.id": runner.id,
      "hypotenuse.runner.name": runner.name,
    }),
  );
  await enqueueTelemetry(
    item.projectId,
    signal as OtlpSignal,
    pinned,
    trace.traceId,
  );
  return { status: 202, body: { accepted: true } };
}

/**
 * Keep only a turn's own spans and logs: spans of another trace are dropped,
 * logs of another trace too, and a log naming no trace is given the turn's.
 * @param signal - The signal.
 * @param request - The batch.
 * @param traceId - The turn's trace.
 * @returns The batch.
 */
function pinToTrace<S extends OtlpSignal>(
  signal: S,
  request: OtlpRequestBySignal[S],
  traceId: string,
): OtlpRequestBySignal[S] {
  if (signal === "traces") {
    for (const rs of (request as TracesRequest).resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        ss.spans = (ss.spans ?? []).filter((s) => s.traceId === traceId);
  } else if (signal === "logs") {
    for (const rl of (request as LogsRequest).resourceLogs ?? [])
      for (const sl of rl.scopeLogs ?? [])
        sl.logRecords = (sl.logRecords ?? [])
          .filter((l) => !l.traceId || l.traceId === traceId)
          .map((l) => ({ ...l, traceId }));
  }
  return request;
}

/**
 * The probe `telemetry-exporter:test` sends: one span, one log, one metric,
 * each POSTed straight to the collector.
 * @param exporter - The exporter.
 * @returns Each enabled signal's outcome.
 */
export async function probeExporter(
  exporter: TelemetryExporter,
): Promise<Partial<Record<OtlpSignal, PostOutcome>>> {
  const now = Date.now();
  const traceId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
  const spanId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(8)),
  ).toString("hex");
  const resource = {
    attributes: attributes({
      "service.name": "hypotenuse-server",
      "hypotenuse.project.id": exporter.projectId,
      "hypotenuse.probe": true,
      ...exporter.resourceAttributes,
    }),
  };
  const scope = { name: "hypotenuse.probe", version: "1" };
  const requests: { [S in OtlpSignal]: OtlpRequestBySignal[S] } = {
    traces: {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                {
                  traceId,
                  spanId,
                  name: "hypotenuse.probe",
                  kind: SPAN_KIND.internal,
                  startTimeUnixNano: unixNano(now),
                  endTimeUnixNano: unixNano(now + 1),
                  attributes: attributes({
                    "hypotenuse.exporter.id": exporter.id,
                  }),
                },
              ],
            },
          ],
        },
      ],
    },
    logs: {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: unixNano(now),
                  severityNumber: 9,
                  severityText: "INFO",
                  body: {
                    stringValue: `Hypotenuse telemetry probe for exporter ${exporter.name}`,
                  },
                  traceId,
                  spanId,
                },
              ],
            },
          ],
        },
      ],
    },
    metrics: {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: [
                {
                  name: "hypotenuse.probe",
                  unit: "1",
                  gauge: {
                    dataPoints: [{ timeUnixNano: unixNano(now), asInt: "1" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const results: Partial<Record<OtlpSignal, PostOutcome>> = {};
  for (const signal of exporter.signals) {
    results[signal] = await postOtlp(exporter, signal, requests[signal]);
  }
  return results;
}
