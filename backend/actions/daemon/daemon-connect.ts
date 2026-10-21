import { ConnectRequest, runnerChannel } from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { type Action, api, type Connection, config, HTTP_METHOD } from "keryx";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import { rawRequestOf } from "../../ops/RawRequestOps";
import {
  findMachineConflict,
  machineInUseResponse,
  trackRunnerSession,
} from "../../ops/RunnerOps";
import { runners } from "../../schema/runners";

/**
 * `daemon:connect` — trade a runner token for a session cookie the daemon's
 * WebSocket can present, since Keryx authenticates a socket by the
 * `__session` cookie on its upgrade.
 *
 * The session carries only `runnerId` (never a `userId`), is regenerated so a
 * fixated id is worthless, and is recorded in `runner:sessions:<id>` so
 * revocation can delete it. Refuses, writing nothing, a runner whose machine
 * already runs a different live runner: one daemon per machine.
 *
 * Machine traffic: not audited, never MCP, never wrapped by the CLI.
 */
export class DaemonConnect implements Action {
  name = "daemon:connect";
  description =
    "Called by a runner's daemon before it opens its WebSocket: answers its channel and timers and sets the session cookie the socket presents. Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("request")];
  web = { route: "/daemon/connect", method: HTTP_METHOD.POST };
  inputs = ConnectRequest;

  /**
   * @param params - The daemon's machine id.
   * @param connection - The runner's HTTP connection (resolved by the principal hook).
   * @returns The channel and timers, or a 409 when the machine is taken.
   */
  async run(
    params: ConnectRequest,
    connection: Connection<SessionImpl, PrincipalMeta>,
  ) {
    rawRequestOf(connection);
    const runner = connection.metadata.runner!;
    const conflict = await findMachineConflict(runner, params.machineId);
    if (conflict) return machineInUseResponse(conflict);

    await connection.updateSession({ runnerId: runner.id });
    await connection.regenerateSession();
    await trackRunnerSession(runner.id, connection.sessionId);
    await api.db.db
      .update(runners)
      .set({ lastConnectedAt: new Date() })
      .where(eq(runners.id, runner.id));

    return {
      runnerId: runner.id,
      channel: runnerChannel(runner.id),
      heartbeatIntervalMs: config.runners.heartbeatIntervalMs,
      leaseMs: config.runners.leaseMs,
      serverTime: Date.now(),
    };
  }
}
