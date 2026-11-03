import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  loadSchedule,
  scheduleNotFound,
  serializeSchedule,
} from "../../ops/ScheduleOps";

/**
 * `schedule:view` — one schedule, with its next five slots. Needs the bot's
 * read access.
 */
export class ScheduleView implements Action {
  name = "schedule:view";
  description =
    "Read one schedule: its cron in words, time zone, target, instruction, guard, and its next five slots (epoch ms). Needs the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule/:scheduleId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scheduleId: idInput("The schedule"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The schedule.
   */
  async run(params: ActionParams<ScheduleView>, connection: AuditedConnection) {
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
    return { schedule: serializeSchedule(schedule, { nextSlots: 5 }) };
  }
}
