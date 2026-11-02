import { and, count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  loadSchedule,
  scheduleNotFound,
  serializeScheduleRun,
} from "../../ops/ScheduleOps";
import {
  SCHEDULE_RUN_STATUSES,
  scheduleRuns,
} from "../../schema/schedule_runs";

/**
 * `schedule:runs` — a schedule's run history, newest slot first. Needs the
 * bot's read access.
 */
export class ScheduleRuns implements Action {
  name = "schedule:runs";
  description =
    "List a schedule's runs, newest slot first: each slot's status (pending, guarding, skipped, woken, silent, posted, failed), why it skipped or failed, the guard's answer, the conversation it woke, and its cost where reported. Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule/:scheduleId/runs",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    scheduleId: idInput("The schedule"),
    status: z
      .enum(SCHEDULE_RUN_STATUSES)
      .optional()
      .describe("Only runs with this status"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The runs and pagination metadata.
   */
  async run(params: ActionParams<ScheduleRuns>, connection: AuditedConnection) {
    const schedule = await loadSchedule(
      api.db.db,
      params.projectId,
      params.scheduleId,
    );
    await loadReadableBot(
      api.db.db,
      params.projectId,
      schedule.botId,
      connection.metadata.callerTags ?? [],
    ).catch(() => {
      throw scheduleNotFound();
    });
    const where = and(
      eq(scheduleRuns.scheduleId, schedule.id),
      params.status ? eq(scheduleRuns.status, params.status) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(scheduleRuns)
        .where(where)
        .orderBy(desc(scheduleRuns.slot), desc(scheduleRuns.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(scheduleRuns).where(where),
      params,
    );
    return {
      runs: result.data.map(serializeScheduleRun),
      pagination: result.pagination,
    };
  }
}
