import { HeartbeatRequest, isSupportedProtocol } from "@hypotenuse/protocol";
import { type Action, api, type Connection, config, HTTP_METHOD } from "keryx";
import { RunnerRateLimitMiddleware } from "../../middleware/runnerRateLimit";
import type { PrincipalMeta, SessionImpl } from "../../middleware/session";
import { protocolUnsupportedResponse } from "../../ops/DaemonPolicyOps";
import { getIntegration } from "../../ops/IntegrationOps";
import { loadCatalog } from "../../ops/LinearCatalogOps";
import {
  applyHeartbeat,
  findMachineConflict,
  type HeartbeatResult,
  isMachineIndexViolation,
  machineInUseResponse,
  publishRunnersChanged,
} from "../../ops/RunnerOps";
import { applyEffects, heartbeatWork, noEffects } from "../../ops/WorkItemOps";

/**
 * `daemon:heartbeat` — liveness, capabilities, and the daemon's work: the
 * offers standing for it, the held turns it must cancel, and the leases of
 * the turns it reports renewed. Every 15 s, and immediately on any frame on
 * the runner's channel.
 *
 * Capabilities and subscriptions are rewritten only when their hash changes,
 * and the dashboard is told only when something it shows changed. A second
 * live runner on the same machine is refused with a 409 and nothing written —
 * including when two start at once, which the live-machine unique index
 * settles.
 *
 * `unknownActive` lists the items the daemon reports that the server no
 * longer considers its own (a lapsed lease, a reassignment, a closed cancel);
 * the daemon stops work on them without writing further. A heartbeat that
 * changed what routing reads (presence, capacity, capabilities) runs a
 * routing pass.
 *
 * A **dry run** (`dryRun: true`, sent by `config validate --online` and
 * `doctor`) writes nothing: it answers who the token is and which subscribed
 * team keys the project's Linear connection cannot see, with no offers.
 *
 * Machine traffic: not audited, never MCP, never wrapped by the CLI.
 */
export class DaemonHeartbeat implements Action {
  name = "daemon:heartbeat";
  description =
    "Called by a runner's daemon every heartbeat interval: reports liveness and capabilities, and answers offers and cancels. Runner token only.";
  mcp = { tool: false };
  middleware = [RunnerRateLimitMiddleware("heartbeat")];
  web = { route: "/daemon/heartbeat", method: HTTP_METHOD.POST };
  inputs = HeartbeatRequest;

  /**
   * @param params - The heartbeat.
   * @param connection - The runner's connection (resolved by the principal hook).
   * @returns The heartbeat response, or a 426 / 409 response.
   */
  async run(
    params: HeartbeatRequest,
    connection: Connection<SessionImpl, PrincipalMeta>,
  ) {
    if (!isSupportedProtocol(params.protocolVersion)) {
      return protocolUnsupportedResponse();
    }
    const runner = connection.metadata.runner!;
    if (params.dryRun) return dryRun(params, connection);

    let result: HeartbeatResult;
    let work: Awaited<ReturnType<typeof heartbeatWork>> = {
      offers: [],
      cancels: [],
      unknownActive: [],
    };
    try {
      result = await api.db.db.transaction(async (tx) => {
        const applied = await applyHeartbeat(tx, runner.id, params);
        if (!applied.conflict) {
          work = await heartbeatWork(
            tx,
            runner.id,
            params.active.map((item) => item.workItemId),
          );
        }
        return applied;
      });
    } catch (error) {
      if (!isMachineIndexViolation(error)) throw error;
      const conflict = await findMachineConflict(runner, params.machineId);
      return machineInUseResponse(
        conflict ?? { runnerId: null, runnerName: null },
      );
    }
    if (result.conflict) return machineInUseResponse(result.conflict);
    if (result.changed) {
      await publishRunnersChanged(runner.projectId);
      await applyEffects({ ...noEffects(), route: true });
    }

    return {
      serverTime: Date.now(),
      heartbeatIntervalMs: config.runners.heartbeatIntervalMs,
      leaseMs: config.runners.leaseMs,
      ...work,
    };
  }
}

/**
 * Answer a dry-run heartbeat: the same refusals, no writes. Team keys are
 * checked against the integration's (cached) catalog; `null` when there is no
 * working connection to ask.
 * @param params - The heartbeat.
 * @param connection - The runner's connection.
 * @returns The answer, or the 409 a real heartbeat would get.
 */
const dryRun = async (
  params: HeartbeatRequest,
  connection: Connection<SessionImpl, PrincipalMeta>,
) => {
  const runner = connection.metadata.runner!;
  const conflict = await findMachineConflict(runner, params.machineId);
  if (conflict) return machineInUseResponse(conflict);
  let unknownSubscriptions: { teams: string[] } | null = null;
  try {
    const integration = await getIntegration(runner.projectId, "linear");
    if (integration && integration.status === "active") {
      const keys = new Set(
        (await loadCatalog(integration)).teams.map((t) => t.key),
      );
      unknownSubscriptions = {
        teams: params.capabilities.subscriptions.teams.filter(
          (team) => !keys.has(team),
        ),
      };
    }
  } catch {
    unknownSubscriptions = null;
  }
  return {
    serverTime: Date.now(),
    heartbeatIntervalMs: config.runners.heartbeatIntervalMs,
    leaseMs: config.runners.leaseMs,
    offers: [],
    cancels: [],
    unknownActive: [],
    runner: {
      id: runner.id,
      name: runner.name,
      projectId: runner.projectId,
      projectSlug:
        connection.metadata.project?.slug ?? String(runner.projectId),
    },
    unknownSubscriptions,
  };
};
