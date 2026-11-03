import { and, asc, count, eq } from "drizzle-orm";
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
import { serializeSchedule } from "../../ops/ScheduleOps";
import { schedules } from "../../schema/schedules";

/**
 * `schedule:list` — a bot's schedules, proposed ones included. Needs the
 * bot's read access.
 */
export class ScheduleList implements Action {
  name = "schedule:list";
  description =
    "List a bot's schedules with their cron, time zone, target, guard, whether each is enabled, whether the bot proposed it, and its next slot; optionally only enabled or only disabled ones. Needs the bot's read access. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/schedules",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    enabled: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional()
      .describe("Only enabled (true) or only disabled (false) schedules"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The schedules and pagination metadata.
   */
  async run(params: ActionParams<ScheduleList>, connection: AuditedConnection) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    const where = and(
      eq(schedules.botId, bot.id),
      params.enabled !== undefined
        ? eq(schedules.enabled, params.enabled)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(schedules)
        .where(where)
        .orderBy(asc(schedules.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(schedules).where(where),
      params,
    );
    return {
      schedules: result.data.map((s) => serializeSchedule(s)),
      pagination: result.pagination,
    };
  }
}
