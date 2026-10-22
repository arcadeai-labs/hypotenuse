import { ClaimRequest } from "@hypotenuse/protocol";
import { type Action, api, type Connection, HTTP_METHOD } from "keryx";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import { applyIssueHygiene } from "../../ops/IssueHygieneOps";
import { applyEffects, claimWork } from "../../ops/WorkItemOps";

/**
 * `daemon:claim` — take an offer. The oldest offer standing for this runner
 * (or one of `workItemIds`) is taken `FOR UPDATE SKIP LOCKED`, its capacity
 * re-checked under the runner's row lock, and answered as a `WorkAssignment`:
 * the issue, the context, the history rebuilt from activities, the prompt for
 * this turn, and the lease. Nothing to claim is `{ assignment: null }`, not an
 * error. Repeating a claim for an item this runner holds answers the same
 * assignment.
 *
 * A claim also links the session to its dashboard page (once), and — for a
 * session's first turn, after the claim commits and before it is answered —
 * applies issue hygiene (`IssueHygieneOps`): the started-state move and the
 * delegate. Hygiene never fails the claim.
 *
 * Machine traffic: not audited, never MCP, never wrapped by the CLI.
 */
export class DaemonClaim implements Action {
  name = "daemon:claim";
  description =
    "Called by a runner's daemon to claim work offered to it: answers the turn's assignment, or null. Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("request")];
  web = { route: "/daemon/claim", method: HTTP_METHOD.POST };
  inputs = ClaimRequest;

  /**
   * @param params - Which offers, if any.
   * @param connection - The runner's connection (resolved by the principal hook).
   * @returns `{ assignment }`.
   */
  async run(
    params: ClaimRequest,
    connection: Connection<SessionImpl, PrincipalMeta>,
  ) {
    const runner = connection.metadata.runner!;
    const result = await api.db.db.transaction((tx) =>
      claimWork(tx, runner, params),
    );
    await applyEffects(result.effects);
    if (result.assignment)
      await applyIssueHygiene(result.assignment.workItemId);
    return { assignment: result.assignment };
  }
}
