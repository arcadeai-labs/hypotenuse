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
  assertUnderLimit,
  catchUpInput,
  cronInput,
  guardInput,
  instructionInput,
  instructionRequired,
  resolveTarget,
  scheduleKindInput,
  scheduleNameInput,
  serializeSchedule,
  targetTypeInput,
  timeZoneInput,
} from "../../ops/ScheduleOps";
import { schedules } from "../../schema/schedules";

/**
 * `schedule:create` — attach a cron schedule to a bot and a target. Needs the
 * bot's write access. Audited.
 */
export class ScheduleCreate extends AuditedAction {
  name = "schedule:create";
  description =
    "Wake a bot on a cron schedule: five cron fields read in an IANA time zone, an instruction, and a target — a channel (a new conversation each slot), one of the bot's conversations (a turn in it), or none (memory and goals only). An optional guard is checked by the bot's fast model once per slot before it wakes. kind goal-review wakes it to review its goals. Slots are at least 5 minutes apart; a bot has at most 10 schedules. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/schedule",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    name: scheduleNameInput,
    kind: scheduleKindInput.default("instruction"),
    targetType: targetTypeInput,
    channelId: idInput("The channel, for a channel target").optional(),
    conversationId: idInput(
      "The conversation, for a conversation target",
    ).optional(),
    cron: cronInput,
    timeZone: timeZoneInput.default("UTC"),
    instruction: instructionInput.default(""),
    guard: guardInput.default(null),
    catchUp: catchUpInput.default("latest"),
    enabled: z
      .boolean()
      .default(true)
      .describe("Whether it fires (default true)"),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The schedule.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ScheduleCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      params.botId,
      tags,
      {
        lock: true,
      },
    );
    assertCanWriteBot(bot, tags);
    await assertUnderLimit(tx, bot.id);
    const nextRunAt = assertRunnableCron(params.cron, params.timeZone);
    const target = await resolveTarget(tx, bot, params);
    if (params.kind === "instruction" && !params.instruction) {
      throw instructionRequired();
    }
    const [schedule] = await tx
      .insert(schedules)
      .values({
        projectId: bot.projectId,
        botId: bot.id,
        name: params.name,
        kind: params.kind,
        targetType: params.targetType,
        ...target,
        cron: params.cron,
        timeZone: params.timeZone,
        instruction: params.instruction,
        guard: params.guard,
        catchUp: params.catchUp,
        enabled: params.enabled,
        nextRunAt,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();
    const serialized = serializeSchedule(schedule, { nextSlots: 5 });
    connection.metadata.auditAfter = serializeSchedule(schedule);
    connection.metadata.auditTargetType = "schedule";
    connection.metadata.auditTargetPath = `${bot.slug}/${schedule.id}`;
    return { schedule: serialized };
  }
}
