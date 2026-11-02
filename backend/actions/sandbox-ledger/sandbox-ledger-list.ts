import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { LIVE_SANDBOX_STATUSES, serializeSandbox } from "../../ops/SandboxOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";

/**
 * `sandbox-ledger:list` — the project's sandbox ledger: every sandbox
 * Hypotenuse asked a provider for, newest first, with its job and what it
 * was given. `live` narrows to those that may still be running (and
 * costing). Requires membership.
 *
 * Named `sandbox-ledger:`, not `sandbox:`: that namespace is the job
 * token's machine actions.
 */
export class SandboxLedgerList implements Action {
  name = "sandbox-ledger:list";
  description =
    "List the project's sandboxes from the ledger, newest first: provider, provider-side id, status, the job each ran, and the resources it was given (vCPUs, memory, timeout, runtime or image). live=true shows only those that may still be running. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/sandboxes", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose sandboxes to list"),
    live: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .optional()
      .transform((v) => v === true || v === "true")
      .describe("Only sandboxes that may still be running"),
  });

  /**
   * @param params - `projectId`, `live`, and pagination inputs.
   * @returns The sandboxes, each with its job's title and status.
   */
  async run(params: ActionParams<SandboxLedgerList>) {
    const conditions: SQL[] = [eq(sandboxes.projectId, params.projectId)];
    if (params.live) {
      conditions.push(inArray(sandboxes.status, LIVE_SANDBOX_STATUSES));
    }
    const where = and(...conditions);
    const result = await paginate(
      api.db.db
        .select({
          sandbox: sandboxes,
          jobTitle: sandboxJobs.title,
          jobStatus: sandboxJobs.status,
        })
        .from(sandboxes)
        .leftJoin(sandboxJobs, eq(sandboxJobs.id, sandboxes.jobId))
        .where(where)
        .orderBy(desc(sandboxes.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(sandboxes).where(where),
      params,
    );
    return {
      sandboxes: result.data.map((r) => ({
        ...serializeSandbox(r.sandbox),
        job: r.sandbox.jobId
          ? {
              id: r.sandbox.jobId,
              title: r.jobTitle,
              status: r.jobStatus,
            }
          : null,
      })),
      pagination: result.pagination,
    };
  }
}
