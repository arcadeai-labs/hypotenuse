import { CompleteRequest } from "@hypotenuse/protocol";
import { type Action, api, type Connection, HTTP_METHOD } from "keryx";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import {
  applyEffects,
  completeWork,
  DaemonRefusal,
} from "../../ops/WorkItemOps";

/**
 * `daemon:complete` — a turn ended on the runner. The item becomes terminal,
 * the runner's slot is free, and the session is guaranteed an answer: if the
 * turn wrote no `response`, `error`, or `elicitation`, the server writes one.
 * Routing then runs, so a queued follow-up starts at once. Completing a
 * terminal item again answers `{ alreadyTerminal: true }`.
 *
 * Machine traffic: not audited (recorded in `work_items`), never MCP, never
 * wrapped by the CLI.
 */
export class DaemonComplete implements Action {
  name = "daemon:complete";
  description =
    "Called by a runner's daemon when a turn ends (completed, failed, or cancelled). Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("request")];
  web = { route: "/daemon/complete", method: HTTP_METHOD.POST };
  inputs = CompleteRequest;

  /**
   * @param params - The completion.
   * @param connection - The runner's connection (resolved by the principal hook).
   * @returns `{ alreadyTerminal }`, or a refusal response.
   */
  async run(
    params: CompleteRequest,
    connection: Connection<SessionImpl, PrincipalMeta>,
  ) {
    const runner = connection.metadata.runner!;
    try {
      const result = await api.db.db.transaction((tx) =>
        completeWork(tx, runner.id, params),
      );
      await applyEffects(result.effects);
      return { alreadyTerminal: result.alreadyTerminal };
    } catch (e) {
      if (e instanceof DaemonRefusal) return e.toResponse();
      throw e;
    }
  }
}
