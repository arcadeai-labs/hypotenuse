import { and, count, desc, eq, ne } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import {
  canManageRunner,
  runnerOwners,
  serializeRunner,
} from "../../ops/RunnerOps";
import { RUNNER_STATUSES, runners } from "../../schema/runners";

/**
 * `runner:list` — a project's runners, newest first, with each one's owner,
 * presence, capacity, and agents as its last heartbeat reported them, and
 * whether the caller may manage it. Revoked runners are left out unless
 * asked for. Requires membership. Paginated.
 */
export class RunnerList implements Action {
  name = "runner:list";
  description =
    "List a project's runners (machines that run coding agents): owner, status (online, offline, draining, revoked), capacity, agents, repositories, and last heartbeat. Revoked runners are omitted unless includeRevoked is set. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/runners", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose runners to list"),
    status: z
      .enum(RUNNER_STATUSES)
      .optional()
      .describe("Only runners in this status"),
    userId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only runners owned by this user"),
    includeRevoked: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .optional()
      .transform((v) => v === true || v === "true")
      .describe("Include revoked runners"),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @param connection - The caller's connection.
   * @returns This page of runners plus pagination metadata.
   */
  async run(
    params: ActionParams<RunnerList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const where = and(
      eq(runners.projectId, params.projectId),
      params.status ? eq(runners.status, params.status) : undefined,
      params.userId ? eq(runners.userId, params.userId) : undefined,
      params.includeRevoked || params.status === "revoked"
        ? undefined
        : ne(runners.status, "revoked"),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(runners)
        .where(where)
        .orderBy(desc(runners.createdAt), desc(runners.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(runners).where(where),
      params,
    );
    const owners = await runnerOwners(result.data.map((r) => r.userId));
    const userId = connection.session!.data.userId!;
    const tags = connection.metadata.callerTags ?? [];
    return {
      runners: result.data.map((row) =>
        serializeRunner(row, {
          owner: owners.get(row.userId) ?? null,
          canManage: canManageRunner(userId, tags, row),
        }),
      ),
      pagination: result.pagination,
    };
  }
}
