import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  loadSchedule,
  scheduleNotFound,
  serializeSchedule,
} from "../../ops/ScheduleOps";
import { schedules } from "../../schema/schedules";

/**
 * `schedule:delete` — remove a schedule and its run history. A turn it
 * already woke finishes. Needs the bot's write access. Audited.
 */
export class ScheduleDelete extends AuditedAction {
  name = "schedule:delete";
  description =
    "Delete a schedule and its run history. A conversation it already woke keeps going. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule/:scheduleId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scheduleId: idInput("The schedule"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The deleted schedule.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ScheduleDelete>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const schedule = await loadSchedule(
      tx,
      params.projectId,
      params.scheduleId,
      {
        lock: true,
      },
    );
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      schedule.botId,
      tags,
    ).catch(() => {
      throw scheduleNotFound();
    });
    assertCanWriteBot(bot, tags);
    const serialized = serializeSchedule(schedule);
    await tx.delete(schedules).where(eq(schedules.id, schedule.id));
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "schedule";
    connection.metadata.auditTargetPath = `${bot.slug}/${schedule.id}`;
    return { schedule: serialized };
  }
}
