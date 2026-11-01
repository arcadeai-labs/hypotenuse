import { and, asc, count, eq, gt } from "drizzle-orm";
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
import { idInput } from "../../ops/InputOps";
import { loadReadableJob } from "../../ops/SandboxJobOps";
import {
  type SandboxJobEvent,
  sandboxJobEvents,
} from "../../schema/sandbox_job_events";

/**
 * Shape a transcript event for any answer.
 * @param e - The row.
 * @returns The serialized event.
 */
function serializeEvent(e: SandboxJobEvent) {
  return {
    id: e.id,
    seq: e.seq,
    kind: e.kind,
    toolName: e.toolName,
    text: e.text,
    payload: e.payload,
    occurredAt: e.occurredAt.getTime(),
  };
}

/**
 * `sandbox-job:events` — a job's transcript: the coding agent's own events,
 * in order. `afterSeq` reads only what is new since a previous page.
 */
export class SandboxJobEvents implements Action {
  name = "sandbox-job:events";
  description =
    "Read a sandbox job's transcript — what the coding agent said, which tools it ran, what they returned — oldest first. Pass afterSeq to read only events after one you have. Requires membership and read access to the job's bot. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/sandbox-job/:jobId/events",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    jobId: idInput("The job"),
    afterSeq: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only events after this sequence number"),
  });

  /**
   * @param params - The job, the cursor, and pagination.
   * @param connection - The caller's connection.
   * @returns The events and pagination.
   */
  async run(
    params: ActionParams<SandboxJobEvents>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const { job } = await loadReadableJob(
      api.db.db,
      params.projectId,
      params.jobId,
      connection.metadata.callerTags ?? [],
    );
    const where = and(
      eq(sandboxJobEvents.jobId, job.id),
      params.afterSeq !== undefined
        ? gt(sandboxJobEvents.seq, params.afterSeq)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(sandboxJobEvents)
        .where(where)
        .orderBy(asc(sandboxJobEvents.seq))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(sandboxJobEvents).where(where),
      params,
    );
    return {
      events: result.data.map(serializeEvent),
      pagination: result.pagination,
    };
  }
}
