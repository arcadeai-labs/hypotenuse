import { Action, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import { checkDependencies, failingChecks } from "../ops/HealthOps";

export class Health implements Action {
  name = "health";
  description =
    "The load balancer's probe: answers 200 with `{ healthy: true }` when the database (with its required `vector` extension) and Redis are reachable, and an error (HTTP 500) naming each failing check otherwise. `status` carries the full report. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/health", method: HTTP_METHOD.GET };
  tracing = false;

  /**
   * Probe Postgres and Redis, and fail the request when this process cannot
   * serve. A deploy's health check reads only the HTTP status, never a body,
   * so an unhealthy verdict has to be a non-2xx answer to hold a deploy.
   * @returns `{ healthy: true }` and the checks.
   * @throws {TypedError} When any check fails, naming each one.
   */
  async run() {
    const health = await checkDependencies();
    if (!health.healthy) {
      throw new TypedError({
        message: `unhealthy: ${failingChecks(health).join(", ")}`,
        type: ErrorType.CONNECTION_SERVER_ERROR,
      });
    }
    return { healthy: true, checks: health.checks, database: health.database };
  }
}
