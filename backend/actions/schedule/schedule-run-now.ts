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
  enqueueFires,
  insertManualRun,
  loadSchedule,
  scheduleNotFound,
  serializeSchedule,
  serializeScheduleRun,
} from "../../ops/ScheduleOps";

/**
 * `schedule:run-now` — fire a schedule once, now, outside its cron: the
 * guard and the disengagement checks still apply. Works on a disabled
 * schedule too, so a proposal can be tried before it is armed. Needs the
 * bot's write access. Audited.
 */
export class ScheduleRunNow extends AuditedAction {
  name = "schedule:run-now";
  description =
    "Run a schedule once, now, outside its cron — its guard and target checks still apply. Works on a disabled schedule, so a proposed one can be tried before it is enabled. Returns the run; read schedule:runs for how it went. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule/:scheduleId/run",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scheduleId: idInput("The schedule"),
  });

  /**
   * @param tx - The transaction the run and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The run.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ScheduleRunNow>,
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
    const run = await insertManualRun(
      tx,
      schedule,
      connection.session?.data.userId ?? null,
    );
    const serialized = serializeScheduleRun(run);
    connection.metadata.auditBefore = serializeSchedule(schedule);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "schedule";
    connection.metadata.auditTargetPath = `${bot.slug}/${schedule.id}`;
    connection.metadata.afterCommitData = { runId: run.id };
    return { run: serialized };
  }

  /**
   * Fire the run.
   * @param _result - The response.
   * @param _params - The inputs.
   * @param connection - Carries the run.
   */
  async afterCommit(
    _result: unknown,
    _params: unknown,
    connection: AuditedConnection,
  ) {
    const runId = connection.metadata.afterCommitData?.runId as
      | number
      | undefined;
    if (runId) await enqueueFires([runId]);
  }
}
