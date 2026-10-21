import {
  type Action,
  type ActionParams,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import {
  canManageRunner,
  getRunnerSubscriptions,
  isSocketAttached,
  runnerInProject,
  runnerOwners,
  serializeRunner,
} from "../../ops/RunnerOps";

/**
 * `runner:view` — one runner as the server last saw it: capabilities,
 * subscriptions, presence (`online`) and, separately, whether a socket is
 * attached (`socketAttached`) — the difference between the two is a daemon
 * behind a proxy that eats WebSockets, or a wedged one. `standing.canManage`
 * says whether the caller may edit or revoke it. Requires membership.
 */
export class RunnerView implements Action {
  name = "runner:view";
  description =
    "Show one runner of a project: owner, status, whether its WebSocket is attached, capacity, roles, agents, repositories, subscriptions, versions, and whether you can manage it. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/runner/:id", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the runner belongs to"),
    id: z.coerce.number().int().positive().describe("The runner's id"),
  });

  /**
   * @param params - The project and runner.
   * @param connection - The caller's connection.
   * @returns The runner.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the project.
   */
  async run(
    params: ActionParams<RunnerView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const row = await runnerInProject(params.projectId, params.id);
    const [owners, subscriptions, socketAttached] = await Promise.all([
      runnerOwners([row.userId]),
      getRunnerSubscriptions(row.id),
      isSocketAttached(row.id),
    ]);
    return {
      runner: serializeRunner(row, {
        owner: owners.get(row.userId) ?? null,
        subscriptions,
        socketAttached,
        canManage: canManageRunner(
          connection.session!.data.userId!,
          connection.metadata.callerTags ?? [],
          row,
        ),
      }),
    };
  }
}
