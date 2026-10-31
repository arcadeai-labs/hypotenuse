import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { goalReviewDue } from "../ops/PromptOps";
import { goals } from "../schema/goals";
import type { ToolDefinition } from "./types";

const input = z.object({
  status: z
    .enum(["active", "achieved", "dropped", "all"])
    .optional()
    .describe("Which goals: active (the default), achieved, dropped, or all"),
});

const output = z.object({
  goals: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      description: z.string(),
      status: z.string(),
      priority: z.string(),
      notes: z.string(),
      reviewDue: z.boolean(),
    }),
  ),
});

/** `goal_list` — the bot's goals, with notes. Replay safe. */
export const goalList: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "goal_list",
  description:
    "List your goals — what the people who run you want you to work toward — with their status, priority, notes, and whether a review is due. Your active goals are also in your instructions; use this for achieved or dropped ones.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: true,
  available: () => true,
  run: async (args, ctx) => {
    const now = new Date();
    const status = args.status ?? "active";
    const rows = await ctx.db
      .select()
      .from(goals)
      .where(eq(goals.botId, ctx.bot.id))
      .orderBy(asc(goals.position), asc(goals.id));
    return {
      goals: rows
        .filter((g) => status === "all" || g.status === status)
        .map((g) => ({
          id: g.id,
          title: g.title,
          description: g.description,
          status: g.status,
          priority: g.priority,
          notes: g.notes,
          reviewDue: goalReviewDue(g, now),
        })),
    };
  },
};
