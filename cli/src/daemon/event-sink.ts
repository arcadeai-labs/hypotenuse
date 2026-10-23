/**
 * The EventSink: every event a turn produces goes here, never straight to the
 * network.
 *
 * 1. `emit` gives the event a UUID `eventId` and the next `seq` for its work
 *    item and writes it to `pending_events` in the same synchronous call, so
 *    it is durable before the turn continues.
 * 2. The flusher posts each work item's queue in `seq` order, in batches of at
 *    most 50 events or 64 KB, and deletes what the server acknowledged. The
 *    server de-duplicates on `eventId`, so a batch whose answer was lost is
 *    simply sent again.
 * 3. While the server is unreachable events accumulate; a newer ephemeral
 *    event supersedes the session's older unsent ephemerals (`state.ts`).
 * 4. `complete` is queued behind its work item's events: a turn is never
 *    reported finished before its last event lands.
 */

import type { z } from "zod";
import {
  type ActiveItem,
  type CompleteRequest,
  NOT_YOUR_WORK,
  SEQ_REGRESSION,
  SessionEvent,
} from "../../../protocol/src/index";
import { ApiError } from "../api/client";
import { Backoff } from "./backoff";
import type { DaemonApi } from "./daemon-api";
import { type DaemonLog, preview } from "./log";
import type { StateDb } from "./state";

/** The most events per `daemon:events` call the daemon sends. */
export const BATCH_EVENTS = 50;

/** The most bytes per `daemon:events` call the daemon sends. */
export const BATCH_BYTES = 64 * 1024;

/** An event as a turn produces it: everything but the envelope. */
export type EventInput =
  z.input<typeof SessionEvent> extends infer E
    ? E extends unknown
      ? Omit<E, "eventId" | "seq" | "at">
      : never
    : never;

/**
 * What an agent's activity says, for the daemon log: a thought's or answer's
 * text, an action and its parameter (and result), the plan's progress, a
 * usage tally.
 * @param event - The event, as a turn produced it.
 * @returns The description, before `preview` puts it on one line.
 */
export function describeEvent(event: EventInput): string {
  let text: string;
  switch (event.type) {
    case "thought":
    case "response":
    case "error":
      text = event.body;
      break;
    case "elicitation":
      text = event.signal ? `[${event.signal}] ${event.body}` : event.body;
      break;
    case "action":
      text = `${event.action} ${event.parameter}${event.result ? ` → ${event.result}` : ""}`;
      break;
    case "plan": {
      const done = event.entries.filter((e) => e.status === "completed").length;
      const now = event.entries.find((e) => e.status === "in_progress");
      text = `${done}/${event.entries.length} done${now ? `; now: ${now.content}` : ""}`;
      break;
    }
    case "summary":
      text = event.title;
      break;
    case "external_url":
      text = `${event.label} ${event.url}`;
      break;
    case "usage":
      text = [
        event.inputTokens !== undefined && `in=${event.inputTokens}`,
        event.outputTokens !== undefined && `out=${event.outputTokens}`,
        event.costUsd !== undefined && `cost=$${event.costUsd}`,
        event.contextUsed !== undefined &&
          `context=${event.contextUsed}${event.contextSize ? `/${event.contextSize}` : ""}`,
      ]
        .filter(Boolean)
        .join(" ");
      break;
    case "status":
      text = event.state;
      break;
  }
  return text;
}

/** What the sink tells the supervisor. */
export interface SinkHooks {
  /** The server asked for a stop on a work item (`cancelRequested`). */
  onCancelRequested(workItemId: number): void;
  /** The server says a work item is not this runner's (409 `NOT_YOUR_WORK`). */
  onNotYours(workItemId: number): void;
  /** The token stopped working (401). */
  onUnauthorized(): void;
  /** A work item's completion was acknowledged. */
  onCompleted(workItemId: number): void;
  /** The server could not be reached (or answered 5xx / 429). */
  onUnreachable(error: unknown): void;
}

/** A queued completion: the request, and what heartbeats report until it lands. */
export interface QueuedCompletion {
  request: CompleteRequest;
  active: ActiveItem;
}

/** The persisted, ordered queue between turns and the server. */
export class EventSink {
  private flushing: Promise<void> | null = null;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoff = new Backoff();
  /** Per work item: the batch size that last fit (a 413 halves it). */
  private readonly batchLimit = new Map<number, number>();
  private closed = false;
  /** Per work item: the turn's `traceparent`, when its telemetry is traced. */
  private readonly traceparents = new Map<number, string>();

  /**
   * @param state - The state database.
   * @param api - The server.
   * @param log - The daemon log.
   * @param hooks - The supervisor's callbacks.
   */
  constructor(
    private readonly state: StateDb,
    private readonly api: DaemonApi,
    private readonly log: DaemonLog,
    private readonly hooks: SinkHooks,
  ) {}

  /**
   * Queue an event durably and schedule a flush.
   * @param target - The session and work item.
   * @param event - The event, without its envelope.
   * @returns The event's id and `seq`.
   */
  emit(
    target: { agentSessionId: number; workItemId: number },
    event: EventInput,
  ): { eventId: string; seq: number } {
    const eventId = crypto.randomUUID();
    const ephemeral =
      (event.type === "thought" || event.type === "action") &&
      Boolean((event as { ephemeral?: boolean }).ephemeral);
    const seq = this.state.queueEvent({
      eventId,
      agentSessionId: target.agentSessionId,
      workItemId: target.workItemId,
      ephemeral,
      payload: { ...event, eventId, at: Date.now() },
    });
    if (this.log.enabled("debug")) {
      this.log.debug(
        `agent ${event.type}: ${preview(describeEvent(event), this.log.level)}`,
        {
          session: target.agentSessionId,
          workItem: target.workItemId,
          seq,
          ephemeral,
        },
      );
    }
    this.kick();
    return { eventId, seq };
  }

  /**
   * Send a work item's events and completion with its turn's `traceparent`,
   * so the server's spans for them join the turn's trace.
   * @param workItemId - The work item.
   * @param traceparent - The daemon span they are sent from; null to stop.
   */
  trace(workItemId: number, traceparent: string | null): void {
    if (traceparent) this.traceparents.set(workItemId, traceparent);
    else this.traceparents.delete(workItemId);
  }

  /**
   * Queue a work item's completion behind its events.
   * @param completion - The request, and how heartbeats report it meanwhile.
   */
  complete(completion: QueuedCompletion): void {
    this.state.queueCompletion(
      completion.request.workItemId,
      completion as unknown as Record<string, unknown>,
    );
    this.kick();
  }

  /**
   * Completions waiting to be sent, as heartbeats report them.
   * @returns Their active items.
   */
  awaitingCompletion(): ActiveItem[] {
    return this.state.pendingWorkItems().flatMap((id) => {
      const row = this.state.pendingCompletion(id);
      return row ? [(row.payload as unknown as QueuedCompletion).active] : [];
    });
  }

  /** Rows still queued: events plus completions. */
  get depth(): number {
    return (
      this.state.allPendingEvents().length + this.awaitingCompletion().length
    );
  }

  /**
   * Flush now (coalesced with any flush in flight). While a failed flush is
   * waiting out its backoff, a new event only queues; `force` — the server
   * answered a heartbeat again — retries at once.
   * @param force - Retry even during a backoff.
   */
  kick(force = false): void {
    if (this.closed) return;
    if (this.retryTimer && !force) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = this.run().finally(() => {
      this.flushing = null;
      if (this.again && !this.closed) {
        this.again = false;
        this.kick();
      }
    });
  }

  /**
   * Wait for the queue to empty, bounded.
   * @param timeoutMs - The most to wait.
   * @returns Whether everything was sent.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      if (this.state.pendingWorkItems().length === 0) return true;
      if (!this.flushing) this.kick(true);
      await Promise.race([
        this.flushing ?? Bun.sleep(0),
        Bun.sleep(Math.max(0, deadline - Date.now())),
      ]);
      if (this.state.pendingWorkItems().length > 0) await Bun.sleep(50);
    }
    return this.state.pendingWorkItems().length === 0;
  }

  /**
   * Wait, bounded, until one work item's queued events have all reached the
   * server — so a write the server makes for the turn directly (an agent
   * tool's plan, question, or pull request link) lands after them.
   * @param workItemId - The work item.
   * @param timeoutMs - The most to wait.
   * @returns Whether its queue emptied.
   */
  async settled(workItemId: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (this.state.pendingEvents(workItemId, 1).length === 0) return true;
      if (Date.now() >= deadline) return false;
      if (!this.flushing) this.kick(true);
      await Bun.sleep(20);
    }
    return this.state.pendingEvents(workItemId, 1).length === 0;
  }

  /** Stop flushing; whatever is queued stays for the next start. */
  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** One pass over every work item with something queued. */
  private async run(): Promise<void> {
    try {
      for (const workItemId of this.state.pendingWorkItems()) {
        if (this.closed) return;
        await this.flushItem(workItemId);
      }
      this.backoff.succeed();
    } catch (error) {
      const delay =
        error instanceof ApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : this.backoff.fail();
      if (error instanceof ApiError && error.status === 401) {
        this.hooks.onUnauthorized();
        return;
      }
      this.hooks.onUnreachable(error);
      this.log.debug(`event flush failed; retrying in ${delay} ms`, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.kick(true);
        }, delay);
      }
    }
  }

  /**
   * Send one work item's events, then its completion.
   * @param workItemId - The work item.
   * @throws When the server is unreachable; the pass stops and retries later.
   */
  private async flushItem(workItemId: number): Promise<void> {
    for (;;) {
      const limit = this.batchLimit.get(workItemId) ?? BATCH_EVENTS;
      const queued = this.state.pendingEvents(workItemId, limit);
      if (queued.length === 0) break;
      const batch: typeof queued = [];
      let bytes = 0;
      for (const row of queued) {
        const size = JSON.stringify(row.payload).length;
        if (batch.length > 0 && bytes + size > BATCH_BYTES) break;
        batch.push(row);
        bytes += size;
      }
      const ids = batch.map((row) => row.eventId);
      try {
        const answer = await this.api.events(
          {
            workItemId,
            events: batch.map((row) => row.payload) as SessionEvent[],
          },
          this.traceparents.get(workItemId),
        );
        this.state.deleteEvents(ids);
        this.log.debug("events sent", {
          workItem: workItemId,
          seqs: batch.map((row) => row.seq).join(","),
          accepted: answer.accepted,
          duplicates: answer.duplicates,
        });
        if (answer.dropped > 0) {
          this.log.info(
            `server dropped ${answer.dropped} event(s): a stop is in progress`,
            { workItem: workItemId },
          );
        }
        if (answer.cancelRequested) this.hooks.onCancelRequested(workItemId);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.status === 0 ||
          error.status >= 500 ||
          error.status === 429 ||
          error.status === 401
        ) {
          this.state.bumpAttempts(ids);
          throw error;
        }
        if (error.status === 409 && error.type === NOT_YOUR_WORK) {
          this.log.info(
            "the server says this work item is no longer ours; dropping its queue",
            { workItem: workItemId },
          );
          this.state.dropWorkItem(workItemId);
          this.hooks.onNotYours(workItemId);
          return;
        }
        if (error.status === 413) {
          const smaller = Math.max(1, Math.floor(batch.length / 2));
          if (batch.length === 1) {
            this.log.error(
              "a single event is larger than the server accepts; dropping it (a daemon bug)",
              {
                workItem: workItemId,
                event: ids[0],
              },
            );
            this.state.deleteEvents(ids);
          }
          this.batchLimit.set(workItemId, smaller);
          continue;
        }
        const key =
          typeof error.detail.key === "string" ? error.detail.key : "";
        const index = /^events\.(\d+)/.exec(key)?.[1];
        if (error.status === 406 && index !== undefined) {
          const bad = batch[Number(index)];
          this.log.error(
            `the server refused an event (a daemon bug): ${error.message}`,
            {
              workItem: workItemId,
              event: bad?.eventId,
              key,
            },
          );
          if (bad) this.state.deleteEvents([bad.eventId]);
          continue;
        }
        this.log.error(
          `the server refused a batch${error.type === SEQ_REGRESSION ? " for going backwards" : ""} (a daemon bug): ${error.message}`,
          { workItem: workItemId, status: error.status },
        );
        this.state.deleteEvents(ids);
      }
    }

    const row = this.state.pendingCompletion(workItemId);
    if (!row) return;
    const { request } = row.payload as unknown as QueuedCompletion;
    try {
      const answer = await this.api.complete(
        request,
        this.traceparents.get(workItemId),
      );
      this.traceparents.delete(workItemId);
      this.log.info(`reported work item ${request.outcome}`, {
        workItem: workItemId,
        alreadyTerminal: answer.alreadyTerminal,
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500 ||
        error.status === 429 ||
        error.status === 401
      ) {
        throw error;
      }
      this.log.warn(`the server refused a completion: ${error.message}`, {
        workItem: workItemId,
        status: error.status,
      });
    }
    this.state.deleteCompletion(workItemId);
    this.batchLimit.delete(workItemId);
    this.hooks.onCompleted(workItemId);
  }
}
