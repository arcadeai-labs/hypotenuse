/**
 * The daemon's telemetry queue: everything every turn collects waits here,
 * in memory, until it is relayed to `daemon:telemetry` — every 2 seconds, or
 * sooner once 1 MB is waiting, gzipped, one request per turn and signal.
 *
 * **Bounded.** The queue holds at most `[telemetry] buffer_mb`. When a record
 * would overflow it, the oldest log records go first, then the oldest spans;
 * metrics are never dropped. Everything dropped is counted per turn and
 * reported as `hypotenuse.telemetry.dropped` with the turn's next batch.
 *
 * **Never in the way.** Nothing here is awaited by a turn: `add` is
 * synchronous, the flush runs on its own timer, and a failed post retries with
 * backoff inside the buffer's limit. A turn the server refuses — `410` after
 * the late window, `409` when nobody exports it or it is not ours — is
 * forgotten and its records counted as dropped.
 */
import {
  attributes,
  type LogsRequest,
  type MetricsRequest,
  mergeRequests,
  type OtlpRequestBySignal,
  type OtlpSignal,
  TEMPORALITY,
  type TracesRequest,
  unixNano,
} from "../../../protocol/src/index";
import { ApiError } from "../api/client";

/** How often the queue flushes. */
export const FLUSH_INTERVAL_MS = 2_000;

/** Waiting bytes that trigger a flush before the timer. */
export const FLUSH_BYTES = 1024 * 1024;

/** One batch waiting. */
export interface QueuedBatch<S extends OtlpSignal = OtlpSignal> {
  workItemId: number;
  traceparent: string;
  signal: S;
  body: OtlpRequestBySignal[S];
  /** Its JSON size. */
  bytes: number;
}

/** What the queue posts with. */
export interface TelemetrySender {
  telemetry(batch: {
    workItemId: number;
    traceparent: string;
    signal: OtlpSignal;
    gzipped: Uint8Array;
  }): Promise<unknown>;
}

/** What one turn has lost. */
interface Loss {
  spans: number;
  logs: number;
  /** Resource attributes for the dropped-count metric. */
  resource: ReturnType<typeof attributes>;
  traceparent: string;
}

/** The queue. */
export class TelemetryQueue {
  private batches: QueuedBatch[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private backoffUntil = 0;
  private failures = 0;
  /** Turns the server refused: nothing more is sent for them. */
  private readonly refused = new Set<number>();
  /** Per turn: what was dropped since it was last reported. */
  private readonly losses = new Map<number, Loss>();
  /** Every record ever dropped, per turn (for `status` and tests). */
  readonly droppedTotal = new Map<number, number>();

  /**
   * @param sender - The relay (`DaemonApi`).
   * @param capacityBytes - `[telemetry] buffer_mb`, in bytes.
   * @param log - A warning line.
   * @param now - The clock.
   */
  constructor(
    private readonly sender: TelemetrySender,
    public capacityBytes: number,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Start the flush timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the timer (the last flush is {@link drain}'s). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Bytes waiting. */
  get pendingBytes(): number {
    return this.bytes;
  }

  /**
   * Whether the server refused a turn's telemetry.
   * @param workItemId - The turn.
   * @returns True once refused.
   */
  isRefused(workItemId: number): boolean {
    return this.refused.has(workItemId);
  }

  /**
   * Queue a batch. Never throws, never waits.
   * @param batch - The batch, without its size.
   * @param resource - The turn's resource, for its dropped-count metric.
   */
  add<S extends OtlpSignal>(
    batch: Omit<QueuedBatch<S>, "bytes">,
    resource: ReturnType<typeof attributes> = [],
  ): void {
    if (this.refused.has(batch.workItemId)) {
      this.countLoss(batch, resource);
      return;
    }
    const bytes = JSON.stringify(batch.body).length;
    this.batches.push({ ...batch, bytes } as QueuedBatch);
    this.bytes += bytes;
    if (!this.losses.has(batch.workItemId))
      this.losses.set(batch.workItemId, {
        spans: 0,
        logs: 0,
        resource,
        traceparent: batch.traceparent,
      });
    this.evict();
    if (this.bytes >= FLUSH_BYTES) void this.flush();
  }

  /**
   * Count a batch as dropped against its turn.
   * @param batch - The batch.
   * @param resource - The turn's resource, if the turn is new to the queue.
   */
  private countLoss(
    batch: Pick<QueuedBatch, "workItemId" | "signal" | "body" | "traceparent">,
    resource: ReturnType<typeof attributes> = [],
  ): void {
    const loss = this.losses.get(batch.workItemId) ?? {
      spans: 0,
      logs: 0,
      resource,
      traceparent: batch.traceparent,
    };
    const n = countRecords(batch.signal, batch.body);
    if (batch.signal === "traces") loss.spans += n;
    else if (batch.signal === "logs") loss.logs += n;
    this.losses.set(batch.workItemId, loss);
    this.droppedTotal.set(
      batch.workItemId,
      (this.droppedTotal.get(batch.workItemId) ?? 0) + n,
    );
  }

  /** Drop the oldest logs, then the oldest spans, until the queue fits. */
  private evict(): void {
    for (const signal of ["logs", "traces"] as const) {
      while (this.bytes > this.capacityBytes) {
        const index = this.batches.findIndex((b) => b.signal === signal);
        if (index === -1) break;
        const [gone] = this.batches.splice(index, 1);
        if (!gone) break;
        this.bytes -= gone.bytes;
        this.countLoss(gone);
      }
    }
  }

  /**
   * Queue each turn's dropped-count metric, for the losses since the last.
   */
  private reportLosses(): void {
    for (const [workItemId, loss] of this.losses) {
      if (this.refused.has(workItemId)) continue;
      if (loss.spans === 0 && loss.logs === 0) continue;
      const at = unixNano(this.now());
      const point = (kind: string, n: number) => ({
        attributes: attributes({ "hypotenuse.telemetry.kind": kind }),
        timeUnixNano: at,
        asInt: String(n),
      });
      const metrics: MetricsRequest = {
        resourceMetrics: [
          {
            resource: { attributes: loss.resource },
            scopeMetrics: [
              {
                scope: { name: "hypotenuse.daemon" },
                metrics: [
                  {
                    name: "hypotenuse.telemetry.dropped",
                    unit: "{record}",
                    sum: {
                      aggregationTemporality: TEMPORALITY.delta,
                      isMonotonic: true,
                      dataPoints: [
                        ...(loss.spans ? [point("span", loss.spans)] : []),
                        ...(loss.logs ? [point("log", loss.logs)] : []),
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      loss.spans = 0;
      loss.logs = 0;
      // Metrics are never evicted, so this always fits its turn's next post.
      const bytes = JSON.stringify(metrics).length;
      this.batches.push({
        workItemId,
        traceparent: loss.traceparent,
        signal: "metrics",
        body: metrics,
        bytes,
      });
      this.bytes += bytes;
    }
  }

  /**
   * Post everything waiting, one request per turn and signal. Concurrent
   * calls share one flush.
   */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** {@link flush}'s body. */
  private async flushOnce(): Promise<void> {
    if (this.now() < this.backoffUntil) return;
    this.reportLosses();
    if (this.batches.length === 0) return;
    const taken = this.batches;
    this.batches = [];
    this.bytes = 0;
    const groups = new Map<string, QueuedBatch[]>();
    for (const b of taken) {
      const key = `${b.workItemId}|${b.signal}`;
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    const retry: QueuedBatch[] = [];
    let failed = false;
    for (const group of groups.values()) {
      const first = group[0] as QueuedBatch;
      if (this.refused.has(first.workItemId)) {
        for (const b of group) this.countLoss(b);
        continue;
      }
      if (failed) {
        retry.push(...group);
        continue;
      }
      const body = mergeRequests(
        first.signal,
        group.map((b) => b.body) as OtlpRequestBySignal[typeof first.signal][],
      );
      try {
        await this.sender.telemetry({
          workItemId: first.workItemId,
          traceparent: first.traceparent,
          signal: first.signal,
          gzipped: Bun.gzipSync(new TextEncoder().encode(JSON.stringify(body))),
        });
        this.failures = 0;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 409 || error.status === 410 || error.status === 400)
        ) {
          // The server will never take this turn's telemetry.
          this.refused.add(first.workItemId);
          for (const b of group) this.countLoss(b);
          this.log(
            `telemetry for work item ${first.workItemId} refused (${error.status}): ${error.message}`,
          );
          continue;
        }
        failed = true;
        retry.push(...group);
        this.failures++;
        const wait =
          error instanceof ApiError && error.retryAfterMs
            ? error.retryAfterMs
            : Math.min(1000 * 2 ** (this.failures - 1), 60_000);
        this.backoffUntil = this.now() + wait;
      }
    }
    // What failed goes back in front, and the buffer's bound still holds.
    this.batches = [...retry, ...this.batches];
    this.bytes = this.batches.reduce((n, b) => n + b.bytes, 0);
    this.evict();
  }

  /**
   * Flush until empty or the time runs out (shutdown, and a turn's end in
   * tests).
   * @param timeoutMs - The most to wait.
   * @returns Whether everything left.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      this.backoffUntil = Math.min(this.backoffUntil, this.now());
      await this.flush();
      if (this.batches.length === 0) return true;
      if (this.now() >= deadline) return false;
      await Bun.sleep(Math.min(500, Math.max(0, deadline - this.now())));
    }
  }
}

/**
 * How many records a batch holds.
 * @param signal - The signal.
 * @param body - The batch.
 * @returns Spans, log records, or metrics.
 */
function countRecords(signal: OtlpSignal, body: unknown): number {
  if (signal === "traces")
    return ((body as TracesRequest).resourceSpans ?? []).reduce(
      (n, rs) =>
        n +
        (rs.scopeSpans ?? []).reduce((m, s) => m + (s.spans?.length ?? 0), 0),
      0,
    );
  if (signal === "logs")
    return ((body as LogsRequest).resourceLogs ?? []).reduce(
      (n, rl) =>
        n +
        (rl.scopeLogs ?? []).reduce(
          (m, s) => m + (s.logRecords?.length ?? 0),
          0,
        ),
      0,
    );
  return 0;
}
