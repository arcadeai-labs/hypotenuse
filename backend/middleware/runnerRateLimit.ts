import {
  type ActionMiddleware,
  type Connection,
  checkRateLimit,
  config,
  ErrorType,
  TypedError,
} from "keryx";
import type { RunnerMeta } from "./runnerToken";

/**
 * Per-runner request budgets, ported from ToolExec's run-token limiter:
 * `daemon:heartbeat` has its own (`runners.heartbeatLimit` a minute — four
 * scheduled beats plus one per frame), and every other daemon action shares
 * `runners.requestLimit`. Keyed by runner id, so a looping daemon costs its
 * own runner a 429 and nobody else anything.
 *
 * A factory taking the bucket, because middleware is not told which action
 * it guards. Runs after the principal hook, which has already resolved
 * `connection.metadata.runner`; a connection without one never reaches a
 * daemon action.
 * @param bucket - `heartbeat` for `daemon:heartbeat`, `request` for the rest.
 * @returns The middleware.
 */
export function RunnerRateLimitMiddleware(
  bucket: "heartbeat" | "request",
): ActionMiddleware {
  return {
    runBefore: async (_params, connection: Connection) => {
      if (!config.runners.rateLimitEnabled) return;
      const runner = (
        connection as Connection<Record<string, unknown>, RunnerMeta>
      ).metadata.runner;
      if (!runner) return;
      const heartbeat = bucket === "heartbeat";
      const info = await checkRateLimit(
        heartbeat ? `${runner.id}:heartbeat` : `${runner.id}`,
        true,
        {
          limit: heartbeat
            ? config.runners.heartbeatLimit
            : config.runners.requestLimit,
          windowMs: config.runners.rateLimitWindowMs,
          keyPrefix: config.runners.rateLimitKeyPrefix,
        },
      );
      connection.rateLimitInfo = info;
      if (info.retryAfter !== undefined) {
        throw new TypedError({
          message: `Rate limit exceeded for this runner. Try again in ${info.retryAfter} seconds.`,
          type: ErrorType.CONNECTION_RATE_LIMITED,
        });
      }
    },
  };
}
