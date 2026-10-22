import {
  newSpanId,
  parseTraceparent,
  TRACEPARENT_HEADER,
} from "@hypotenuse/protocol";
import { api, Initializer } from "keryx";
import type { PrincipalMeta } from "../middleware/session";
import { DAEMON_ONLY_ACTION_NAMES } from "../ops/DaemonPolicyOps";
import { emitSpans } from "../ops/TelemetryOps";

const namespace = "telemetry";

/**
 * The span a traced `daemon:*` call is, on its connection's metadata: the
 * action reads it to run its Linear calls as this span's children.
 */
export interface DaemonSpanMeta {
  telemetrySpan?: { traceId: string; spanId: string; startMs: number };
}

/**
 * Calls whose traceparent is not a span of the turn's trace: presence and
 * claims are the runner's, not a turn's, and `daemon:telemetry` carries the
 * trace it relays.
 */
const UNTRACED = new Set([
  "daemon:connect",
  "daemon:heartbeat",
  "daemon:claim",
  "daemon:telemetry",
]);

/**
 * Register the hooks that make each `daemon:*` call for a turn a server
 * span: a daemon sends the turn's `traceparent` — naming the daemon span it
 * called from — on every call, and the server's span for the call is that
 * span's child (`daemon:events`, `daemon:complete`, each `daemon:linear-*`).
 * Emitted only for a project that exports telemetry, and into the runner's
 * own project's stream whatever the header says, so a runner can add spans
 * only to its own project's traces.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`.
 */
export class Telemetry extends Initializer {
  constructor() {
    super(namespace);
    this.declaresAPIProperty = false;
  }

  /** Register the hooks. */
  async initialize(): Promise<void> {
    api.hooks.actions.beforeAct((actionName, _params, connection, ctx) => {
      if (!DAEMON_ONLY_ACTION_NAMES.has(actionName) || UNTRACED.has(actionName))
        return;
      const parent = parseTraceparent(
        connection.rawRequest?.headers.get(TRACEPARENT_HEADER),
      );
      if (!parent) return;
      const span = {
        traceId: parent.traceId,
        spanId: newSpanId(),
        startMs: Date.now(),
      };
      ctx.metadata.telemetryParent = parent.spanId;
      (connection.metadata as DaemonSpanMeta).telemetrySpan = span;
    });

    api.hooks.actions.afterAct(
      async (actionName, params, connection, ctx, outcome) => {
        const span = (connection.metadata as DaemonSpanMeta).telemetrySpan;
        const parentSpanId = ctx.metadata.telemetryParent as string | undefined;
        const runner = (connection.metadata as PrincipalMeta).runner;
        if (!span || !parentSpanId || !runner) return;
        const status = outcome.success
          ? outcome.response instanceof Response
            ? outcome.response.status
            : 200
          : 0;
        await emitSpans(runner.projectId, [
          {
            name: actionName,
            kind: "server",
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId,
            startMs: span.startMs,
            endMs: Date.now(),
            attributes: {
              "hypotenuse.runner.id": runner.id,
              "hypotenuse.work_item.id":
                typeof params.workItemId === "number"
                  ? params.workItemId
                  : null,
              "hypotenuse.session.id":
                typeof params.agentSessionId === "number"
                  ? params.agentSessionId
                  : null,
              "hypotenuse.events": Array.isArray(params.events)
                ? params.events.length
                : null,
              "hypotenuse.outcome":
                typeof params.outcome === "string" ? params.outcome : null,
              "http.response.status_code": status || null,
            },
            error: outcome.success
              ? status >= 400
                ? `answered ${status}`
                : null
              : outcome.error instanceof Error
                ? outcome.error.message
                : "failed",
          },
        ]);
      },
    );
  }
}
