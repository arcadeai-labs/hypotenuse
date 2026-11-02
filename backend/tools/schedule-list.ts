import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { describeCron } from "../ops/ScheduleOps";
import { schedules } from "../schema/schedules";
import type { ToolDefinition } from "./types";

const input = z.object({});

const output = z.object({
  schedules: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      kind: z.string(),
      cron: z.string(),
      timeZone: z.string(),
      when: z.string(),
      targetType: z.string(),
      instruction: z.string(),
      guard: z.string().nullable(),
      enabled: z.boolean(),
      proposedByBot: z.boolean(),
      nextRunAt: z.string().nullable(),
    }),
  ),
});

/** `schedule_list` — the bot's own schedules. Replay safe. */
export const scheduleList: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "schedule_list",
  description:
    "List your schedules — the times you are woken to work without being asked — with each one's cron, time zone, instruction, guard, whether it is enabled, and whether you proposed it (a proposal stays disabled until a person enables it).",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (_args, ctx) => {
    const rows = await ctx.db
      .select()
      .from(schedules)
      .where(eq(schedules.botId, ctx.bot.id))
      .orderBy(asc(schedules.id));
    return {
      schedules: rows.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        cron: s.cron,
        timeZone: s.timeZone,
        when: describeCron(s.cron),
        targetType: s.targetType,
        instruction: s.instruction,
        guard: s.guard,
        enabled: s.enabled,
        proposedByBot: s.proposedByBot,
        nextRunAt: s.enabled ? s.nextRunAt.toISOString() : null,
      })),
    };
  },
};
