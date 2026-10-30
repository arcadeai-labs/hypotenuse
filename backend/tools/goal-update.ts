import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { z } from "zod";
import { GOAL_NOTES_MAX } from "../ops/GoalOps";
import { goals } from "../schema/goals";
import { type ToolDefinition, ToolError } from "./types";

const input = z
  .object({
    goalId: z.number().int().positive().describe("The goal's id"),
    status: z
      .enum(["active", "achieved", "dropped"])
      .optional()
      .describe("achieved when it is done, dropped when it no longer applies"),
    notes: z
      .string()
      .max(GOAL_NOTES_MAX)
      .optional()
      .describe(
        "The goal's notes, replaced whole: progress, what is blocking it, what you found in a review",
      ),
  })
  .describe(
    "Send status, notes, or both; sending either also marks a review done",
  );

const output = z.object({
  id: z.number(),
  status: z.string(),
  notes: z.string(),
});

/**
 * `goal_update` — change one of the bot's goals' status or notes, and mark it
 * reviewed. The bot cannot create, delete, or retitle a goal. Unsafe to
 * replay: it overwrites notes.
 */
export const goalUpdate: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "goal_update",
  description:
    "Update one of your goals: set its status (achieved, dropped, or back to active) and replace its notes with where it stands. Calling it also marks a due review done. You cannot create, retitle, or delete goals — people do that; if a goal should change, say so in your reply.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: () => true,
  run: async (args, ctx) => {
    if (args.status === undefined && args.notes === undefined) {
      throw new ToolError(
        "nothing_to_change",
        "Send a status, notes, or both.",
        "Call goal_update again with what changed.",
      );
    }
    const [updated] = await api.db.db
      .update(goals)
      .set({
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        lastReviewedAt: new Date(),
      })
      .where(and(eq(goals.id, args.goalId), eq(goals.botId, ctx.bot.id)))
      .returning();
    if (!updated) {
      throw new ToolError(
        "not_found",
        `You have no goal ${args.goalId}.`,
        "Call goal_list for your goals and their ids.",
      );
    }
    return { id: updated.id, status: updated.status, notes: updated.notes };
  },
};
