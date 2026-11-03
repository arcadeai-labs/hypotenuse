import { eq } from "drizzle-orm";
import { api, TypedError } from "keryx";
import { z } from "zod";
import {
  assertRunnableCron,
  assertUnderLimit,
  describeCron,
  resolveTarget,
} from "../ops/ScheduleOps";
import { channels } from "../schema/channels";
import { schedules } from "../schema/schedules";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  name: z.string().trim().min(1).max(100).describe("A short label for people"),
  cron: z
    .string()
    .trim()
    .min(9)
    .max(200)
    .describe(
      "Five cron fields — minute hour day-of-month month day-of-week — e.g. 0 9 * * 1 for Mondays at 09:00. At least 5 minutes between slots",
    ),
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .default("UTC")
    .describe("The IANA time zone the fields are read in"),
  kind: z
    .enum(["instruction", "goal-review"])
    .default("instruction")
    .describe("instruction, or goal-review to review your goals"),
  instruction: z
    .string()
    .trim()
    .max(4_000)
    .default("")
    .describe("What you should do at each slot"),
  guard: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Optional: run only if this holds, checked once per slot"),
  target: z
    .enum(["this_conversation", "this_channel", "none"])
    .default("this_channel")
    .describe(
      "this_channel (a new conversation here each slot), this_conversation (a turn here), or none (nothing posted)",
    ),
});

const output = z.object({
  id: z.number(),
  name: z.string(),
  when: z.string(),
  enabled: z.literal(false),
  message: z.string(),
});

/**
 * `schedule_propose` — suggest a schedule for yourself. It is written
 * **disabled**, marked as proposed by the bot; only a person enabling it
 * (audited) arms it, so a bot can never schedule itself into a loop. Not
 * audited: a proposal decides nothing. Unsafe to replay: it inserts.
 */
export const schedulePropose: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "schedule_propose",
  description:
    "Propose a schedule for yourself — a time to wake and work toward your goals without being asked (a Monday summary, a daily check). It is saved disabled; a person must enable it before it ever runs, so tell them you proposed it and why.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    if (args.kind === "instruction" && !args.instruction) {
      throw new ToolError(
        "instruction_required",
        "An instruction schedule needs an instruction.",
        "Call schedule_propose again with what you should do at each slot.",
      );
    }
    try {
      return await api.db.db.transaction(async (tx) => {
        await assertUnderLimit(tx, ctx.bot.id);
        const nextRunAt = assertRunnableCron(args.cron, args.timeZone);
        let targetType: "channel" | "conversation" | "none" = "none";
        let channelId: number | null = null;
        let conversationId: number | null = null;
        if (args.target === "this_conversation") {
          targetType = "conversation";
          conversationId = ctx.conversation.id;
        } else if (args.target === "this_channel") {
          targetType = "channel";
          const [channel] = await tx
            .select()
            .from(channels)
            .where(eq(channels.id, ctx.conversation.channelId));
          channelId = channel?.id ?? null;
        }
        const target = await resolveTarget(tx, ctx.bot, {
          targetType,
          channelId,
          conversationId,
        });
        const [row] = await tx
          .insert(schedules)
          .values({
            projectId: ctx.bot.projectId,
            botId: ctx.bot.id,
            name: args.name,
            kind: args.kind,
            targetType,
            ...target,
            cron: args.cron,
            timeZone: args.timeZone,
            instruction: args.instruction,
            guard: args.guard ?? null,
            enabled: false,
            proposedByBot: true,
            proposedInConversationId: ctx.conversation.id,
            nextRunAt,
          })
          .returning();
        return {
          id: row.id,
          name: row.name,
          when: `${describeCron(row.cron)} (${row.timeZone})`,
          enabled: false as const,
          message:
            "Proposed. It stays disabled until a person enables it on your Schedules page.",
        };
      });
    } catch (e) {
      if (e instanceof TypedError) {
        throw new ToolError(
          "invalid_schedule",
          e.message,
          "Fix what the message names and call schedule_propose again, or ask a person to set it up.",
        );
      }
      throw e;
    }
  },
};
