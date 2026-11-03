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
  assertRunnableCron,
  catchUpInput,
  cronInput,
  guardInput,
  instructionInput,
  instructionRequired,
  loadSchedule,
  resolveTarget,
  scheduleKindInput,
  scheduleNameInput,
  scheduleNotFound,
  serializeSchedule,
  targetTypeInput,
  timeZoneInput,
} from "../../ops/ScheduleOps";
import { type NewSchedule, schedules } from "../../schema/schedules";

/**
 * `schedule:edit` — change a schedule, or enable or disable it. Enabling a
 * schedule a bot proposed is how it is armed: a person's decision, audited.
 * Changing its cron or zone, or enabling it, recomputes the next slot from
 * now. Needs the bot's write access.
 */
export class ScheduleEdit extends AuditedAction {
  name = "schedule:edit";
  description =
    "Change a schedule: its name, kind, target, cron, time zone, instruction, guard, or catch-up rule, or enable or disable it. Only the fields sent change. Enabling a schedule a bot proposed arms it. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule/:scheduleId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scheduleId: idInput("The schedule"),
    name: scheduleNameInput.optional(),
    kind: scheduleKindInput.optional(),
    targetType: targetTypeInput.optional(),
    channelId: idInput("The channel, for a channel target").optional(),
    conversationId: idInput(
      "The conversation, for a conversation target",
    ).optional(),
    cron: cronInput.optional(),
    timeZone: timeZoneInput.optional(),
    instruction: instructionInput.optional(),
    guard: guardInput.optional(),
    catchUp: catchUpInput.optional(),
    enabled: z.boolean().optional().describe("Arm or disarm it"),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The schedule.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ScheduleEdit>,
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
    connection.metadata.auditBefore = serializeSchedule(schedule);
    const changes: Partial<NewSchedule> = {};
    for (const key of [
      "name",
      "kind",
      "instruction",
      "guard",
      "catchUp",
      "enabled",
    ] as const) {
      if (params[key] !== undefined) {
        (changes as Record<string, unknown>)[key] = params[key];
      }
    }
    const kind = params.kind ?? schedule.kind;
    const instruction = params.instruction ?? schedule.instruction;
    if (kind === "instruction" && !instruction) throw instructionRequired();
    if (
      params.targetType !== undefined ||
      params.channelId !== undefined ||
      params.conversationId !== undefined
    ) {
      const targetType = params.targetType ?? schedule.targetType;
      Object.assign(
        changes,
        { targetType },
        await resolveTarget(tx, bot, {
          targetType,
          channelId: params.channelId ?? schedule.channelId,
          conversationId: params.conversationId ?? schedule.conversationId,
        }),
      );
    }
    const cron = params.cron ?? schedule.cron;
    const timeZone = params.timeZone ?? schedule.timeZone;
    const arming = params.enabled === true && !schedule.enabled;
    if (params.cron !== undefined || params.timeZone !== undefined || arming) {
      changes.cron = cron;
      changes.timeZone = timeZone;
      changes.nextRunAt = assertRunnableCron(cron, timeZone);
    }
    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(schedules)
            .set(changes)
            .where(eq(schedules.id, schedule.id))
            .returning()
        : [schedule];
    connection.metadata.auditAfter = serializeSchedule(updated);
    connection.metadata.auditTargetType = "schedule";
    connection.metadata.auditTargetPath = `${bot.slug}/${schedule.id}`;
    return { schedule: serializeSchedule(updated, { nextSlots: 5 }) };
  }
}
