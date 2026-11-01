import type { RunnerEvent } from "./parser";

/**
 * Batches parsed events and ships them to `PUT /api/sandbox/events`.
 *
 * **Imports nothing from the backend** — it runs inside the sandbox. See the
 * note at the top of `parser.ts`.
 *
 * Three thresholds, whichever comes first: a chatty agent flushes on count, a
 * quiet one flushes on time, and one that returns a giant tool result flushes on
 * bytes before the request gets too big to accept. Retries are exponential and
 * **nothing is dropped**: when the queue outgrows its bound, {@link
 * EventBatcher.add} stops resolving, which pauses whoever is reading the CLI's
 * stdout. Backpressure into the reader is the only place the slack can go that
 * does not involve losing a run's transcript.
 */
export interface BatcherOptions {
  /** Ship the batch. Rejecting triggers a retry. */
  flush: (events: RunnerEvent[]) => Promise<void>;
  /** Flush once this many events are queued. */
  maxEvents?: number;
  /** Flush once the oldest queued event is this old. */
  maxIntervalMs?: number;
  /** Flush once the queued events serialize to this many bytes. */
  maxBytes?: number;
  /** Queue length past which {@link EventBatcher.add} applies backpressure. */
  maxQueue?: number;
  /** How many times to retry one batch before giving up on it. */
  maxRetries?: number;
  /** First retry delay; each subsequent one doubles. */
  baseRetryMs?: number;
  /** Clock, injectable so tests can drive the age threshold exactly. */
  now?: () => number;
  /** Sleep, injectable so tests do not wait out real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when a batch is abandoned after exhausting its retries. */
  onDropped?: (events: RunnerEvent[], error: unknown) => void;
  /** Called before each retry sleep, so a daemon log can record the blip. */
  onRetry?: (events: RunnerEvent[], attempt: number, error: unknown) => void;
}

/** The default thresholds: flush at ~200 events, 2 s, or 256 KB, whichever first. */
export const BATCHER_DEFAULTS = {
  maxEvents: 200,
  maxIntervalMs: 2_000,
  maxBytes: 256 * 1024,
  maxQueue: 2_000,
  maxRetries: 5,
  baseRetryMs: 250,
} as const;

/**
 * A size-, count-, and time-bounded event batcher with retry and backpressure.
 */
export class EventBatcher {
  private readonly options: Required<
    Omit<BatcherOptions, "onDropped" | "onRetry">
  > & {
    onDropped?: BatcherOptions["onDropped"];
    onRetry?: BatcherOptions["onRetry"];
  };

  private queue: RunnerEvent[] = [];
  private queuedBytes = 0;
  private oldestAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private blockedCallers = 0;

  /** How many events have been shipped successfully. Read by tests and logs. */
  public sent = 0;
  /** How many events were abandoned after exhausting their retries. */
  public dropped = 0;

  /**
   * @param options - Flush callback plus any threshold overrides.
   */
  constructor(options: BatcherOptions) {
    this.options = {
      ...BATCHER_DEFAULTS,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
  }

  /** How many events are queued but not yet shipped. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Whether {@link add} is currently withholding resolution from a caller.
   *
   * Deliberately not "is the queue over its bound": by the time a blocked
   * `add` has started its flush the queue is already empty again, so that
   * reading would be false for the whole time backpressure is actually being
   * applied. What a log line wants to know is whether the reader is stalled.
   */
  get paused(): boolean {
    return this.blockedCallers > 0;
  }

  /**
   * Queue an event, flushing if that crossed a threshold.
   *
   * Awaiting the returned promise is what makes backpressure work: once the
   * queue is over its bound this does not resolve until a flush has drained it,
   * which stops the caller reading more of the CLI's stdout.
   * @param event - The parsed event to ship.
   */
  async add(event: RunnerEvent): Promise<void> {
    if (this.closed) return;

    this.queue.push(event);
    this.queuedBytes += estimateBytes(event);
    this.oldestAt ??= this.options.now();

    const overQueueBound = this.queue.length >= this.options.maxQueue;
    const overThreshold =
      this.queue.length >= this.options.maxEvents ||
      this.queuedBytes >= this.options.maxBytes;

    if (!overQueueBound && !overThreshold) return;

    // Over the queue bound this call is the backpressure: it does not resolve
    // until the flush completes, which stops the caller reading more stdout.
    if (overQueueBound) this.blockedCallers++;
    try {
      await this.flush();
    } finally {
      if (overQueueBound) this.blockedCallers--;
    }
  }

  /**
   * Flush if — and only if — a threshold has been crossed. This is what the
   * runner's interval timer calls, so a quiet agent's few events still ship
   * within `maxIntervalMs` instead of waiting for the run to end.
   */
  async maybeFlush(): Promise<void> {
    if (this.queue.length === 0) return;
    const age = this.oldestAt === null ? 0 : this.options.now() - this.oldestAt;
    if (
      age >= this.options.maxIntervalMs ||
      this.queue.length >= this.options.maxEvents ||
      this.queuedBytes >= this.options.maxBytes
    ) {
      await this.flush();
    }
  }

  /**
   * Ship everything queued, retrying with exponential backoff.
   *
   * Concurrent callers share one in-flight flush rather than racing: two
   * overlapping flushes would interleave batches and put a run's events out of
   * order, and order is the one thing an event log has to get right.
   */
  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      // Whatever arrived while that flush was in the air still needs shipping,
      // but only if this call actually has something to ship.
      if (this.queue.length === 0) return;
    }

    const batch = this.queue;
    if (batch.length === 0) return;

    this.queue = [];
    this.queuedBytes = 0;
    this.oldestAt = null;

    this.inFlight = this.deliver(batch);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Deliver one batch, retrying on failure with a doubling delay.
   * @param batch - The events to ship.
   */
  private async deliver(batch: RunnerEvent[]): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.options.flush(batch);
        this.sent += batch.length;
        return;
      } catch (error) {
        attempt++;
        if (attempt > this.options.maxRetries) {
          this.dropped += batch.length;
          this.options.onDropped?.(batch, error);
          return;
        }
        this.options.onRetry?.(batch, attempt, error);
        await this.options.sleep(this.options.baseRetryMs * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Ship whatever is left and refuse further events. Called once, when the CLI
   * has exited — a run's last events are usually its most interesting.
   */
  async close(): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0 || this.inFlight) {
      await this.flush();
    }
  }
}

/**
 * Approximate an event's serialized size.
 *
 * Deliberately an estimate: exact sizing would mean `JSON.stringify`-ing every
 * event twice, once to measure and once to send, and the threshold exists to
 * keep requests under a limit rather than to hit a number.
 * @param event - The event to measure.
 * @returns Its approximate JSON byte length.
 */
export function estimateBytes(event: RunnerEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    // A payload with a cycle in it cannot be sized or sent; charge it something
    // non-zero so a stream of them still trips the byte threshold.
    return 1024;
  }
}
