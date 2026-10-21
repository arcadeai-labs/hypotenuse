import {
  type EventsRequest,
  MAX_EVENTS_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
  SessionEvent,
} from "@hypotenuse/protocol";
import {
  type Action,
  api,
  type Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import {
  applyEffects,
  applyEvents,
  DaemonRefusal,
} from "../../ops/WorkItemOps";

/**
 * `daemon:events` — the runner's voice in the session. A batch of up to 100
 * events (≤ 256 KiB) for a turn this runner holds, written into the activity
 * outbox in `seq` order with each `eventId` as the activity's client id, so a
 * resent batch never posts twice. Moves the turn to `running` and renews its
 * lease. Once a stop is requested only `response` and `error` are taken; the
 * answer's `cancelRequested` tells a daemon that missed the frame.
 *
 * 409 `NOT_YOUR_WORK` for an item it does not hold, 409 `SEQ_REGRESSION` for a
 * batch going backwards, 406 with the event's index for an invalid event, 413
 * for an oversized batch.
 *
 * Machine traffic: not audited (recorded in `agent_activities`), never MCP,
 * never wrapped by the CLI.
 */
export class DaemonEvents implements Action {
  name = "daemon:events";
  description =
    "Called by a runner's daemon to report what a running turn does (thoughts, actions, plan, the response). Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("request")];
  web = { route: "/daemon/events", method: HTTP_METHOD.POST };
  /**
   * `EventsRequest`, with each event left to {@link parseEvents}: Keryx's own
   * validation reports only a param's first path segment, and the daemon
   * needs to know *which* event was refused.
   */
  inputs = z.strictObject({
    workItemId: z.number().int().positive(),
    events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
  });

  /**
   * @param params - The batch.
   * @param connection - The runner's connection (resolved by the principal hook).
   * @returns The counts, or a refusal response.
   */
  async run(
    params: { workItemId: number; events: unknown[] },
    connection: Connection<SessionImpl, PrincipalMeta>,
  ) {
    if (JSON.stringify(params.events).length > MAX_EVENTS_BATCH_BYTES) {
      return Response.json(
        {
          error: {
            type: "PAYLOAD_TOO_LARGE",
            message: `A batch of events is at most ${MAX_EVENTS_BATCH_BYTES} bytes; split it and resend.`,
          },
        },
        { status: 413 },
      );
    }
    const request: EventsRequest = {
      workItemId: params.workItemId,
      events: parseEvents(params.events),
    };
    const runner = connection.metadata.runner!;
    try {
      const result = await api.db.db.transaction((tx) =>
        applyEvents(tx, runner.id, request),
      );
      await applyEffects(result.effects);
      return result.response;
    } catch (e) {
      if (e instanceof DaemonRefusal) return e.toResponse();
      throw e;
    }
  }
}

/**
 * Validate a batch's events one by one, so a refusal names the event.
 * @param raw - The events as sent.
 * @returns The parsed events.
 * @throws {TypedError} 406 whose `key` is `events.<index>…`.
 */
const parseEvents = (raw: unknown[]): SessionEvent[] =>
  raw.map((event, index) => {
    const parsed = SessionEvent.safeParse(event);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    throw new TypedError({
      message: `Event ${index}: ${issue?.message ?? "invalid"}`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: ["events", index, ...(issue?.path ?? [])].join("."),
    });
  });
