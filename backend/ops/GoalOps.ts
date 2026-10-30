import { and, eq } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import {
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  type Goal,
  goals,
} from "../schema/goals";
import type { DbHandle } from "./DbOps";
import { goalReviewDue } from "./PromptOps";

/**
 * Goals: what a bot works toward. People create, retitle, reorder, and delete
 * them (audited); the bot changes only `status` and `notes`, with
 * `goal_update` (recorded in the transcript).
 */

/** The longest a goal's notes may be. */
export const GOAL_NOTES_MAX = 4_000;

/** The Zod input for a goal's title. */
export const goalTitleInput = z
  .string()
  .trim()
  .min(1, "A goal needs a title")
  .max(200)
  .describe("What the bot is working toward, in a line");

/** The Zod input for a goal's description. */
export const goalDescriptionInput = z
  .string()
  .trim()
  .max(2_000)
  .describe("More about it: what done looks like");

/** The Zod input for a goal's status. */
export const goalStatusInput = z
  .enum(GOAL_STATUSES)
  .describe("active (in the prompt), achieved, or dropped");

/** The Zod input for a goal's priority. */
export const goalPriorityInput = z
  .enum(GOAL_PRIORITIES)
  .describe("high, medium, or low; orders goals in the prompt");

/** The Zod input for a goal's notes. */
export const goalNotesInput = z
  .string()
  .max(GOAL_NOTES_MAX, "Notes are at most 4,000 characters")
  .describe("Progress notes; the bot keeps these too");

/** The Zod input for a goal's review interval. */
export const goalReviewEveryInput = z
  .number()
  .int()
  .min(3_600, "A review interval is at least an hour")
  .max(366 * 86_400)
  .nullable()
  .describe(
    "Seconds between reviews (null: never); when due, the prompt asks the bot to review the goal",
  );

/**
 * The 404 for a goal that is missing or belongs to a bot the caller cannot read.
 * @returns The error.
 */
export function goalNotFound(): TypedError {
  return new TypedError({
    message: "Goal not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a goal of a project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param goalId - The goal.
 * @param options.lock - Take its row lock.
 * @returns The goal.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadGoal(
  db: DbHandle,
  projectId: number,
  goalId: number,
  options: { lock?: boolean } = {},
): Promise<Goal> {
  const query = db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.projectId, projectId)));
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) throw goalNotFound();
  return row;
}

/**
 * Shape a goal for any answer.
 * @param g - The row.
 * @param now - The time, for `reviewDue`.
 * @returns The serialized goal.
 */
export function serializeGoal(g: Goal, now: Date = new Date()) {
  return {
    id: g.id,
    projectId: g.projectId,
    botId: g.botId,
    title: g.title,
    description: g.description,
    status: g.status,
    priority: g.priority,
    notes: g.notes,
    reviewEverySeconds: g.reviewEverySeconds,
    lastReviewedAt: g.lastReviewedAt?.getTime() ?? null,
    reviewDue: goalReviewDue(g, now),
    position: g.position,
    createdByUserId: g.createdByUserId,
    createdAt: g.createdAt.getTime(),
    updatedAt: g.updatedAt.getTime(),
  };
}
