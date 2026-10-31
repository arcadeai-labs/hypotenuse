/**
 * `hypotenuse goal` — what a bot works toward (`goal:*`). People create,
 * change, and delete goals; the bot reads its active ones in its prompt and
 * may change only their status and notes.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseDuration, parseNumber } from "../input";
import { dim, table } from "../output/theme";

/** A goal as the goal actions answer it. */
export interface Goal {
  id: number;
  botId: number;
  title: string;
  description: string;
  status: "active" | "achieved" | "dropped";
  priority: "high" | "medium" | "low";
  notes: string;
  reviewEverySeconds: number | null;
  lastReviewedAt: number | null;
  reviewDue: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

const STATUSES = ["active", "achieved", "dropped"];
const PRIORITIES = ["high", "medium", "low"];

/**
 * A review interval as a person reads it.
 * @param seconds - The interval, or null.
 * @returns `every 7d`, `every 12h`, or `never`.
 */
export function reviewText(seconds: number | null): string {
  if (!seconds) return "never";
  if (seconds % 86_400 === 0) return `every ${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600}h`;
  return `every ${seconds}s`;
}

/**
 * Check a value is one of a set.
 * @param value - What was typed.
 * @param allowed - The choices.
 * @param flag - The flag, for the refusal.
 * @returns The value.
 * @throws {Error} When it is not one of them.
 */
function oneOf(value: string, allowed: string[], flag: string): string {
  if (!allowed.includes(value)) {
    throw new Error(`${flag} is one of ${allowed.join(", ")}; got "${value}".`);
  }
  return value;
}

/** The flags `add` and `edit` share. */
interface GoalFlags {
  title?: string;
  description?: string;
  priority?: string;
  status?: string;
  notes?: string;
  reviewEvery?: string | false;
  position?: string;
}

/**
 * The body `add` and `edit` send, from their flags.
 * @param o - The flags.
 * @returns The request body.
 */
function goalBody(o: GoalFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (o.title !== undefined) body.title = o.title;
  if (o.description !== undefined) body.description = o.description;
  if (o.priority !== undefined)
    body.priority = oneOf(o.priority, PRIORITIES, "--priority");
  if (o.status !== undefined)
    body.status = oneOf(o.status, STATUSES, "--status");
  if (o.notes !== undefined) body.notes = o.notes;
  if (o.reviewEvery === false) body.reviewEverySeconds = null;
  else if (o.reviewEvery !== undefined)
    body.reviewEverySeconds = parseDuration(o.reviewEvery, "--review-every");
  if (o.position !== undefined)
    body.position = parseNumber(o.position, "--position");
  return body;
}

/**
 * Add the flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withGoalFlags(command: Command): Command {
  return command
    .option("--title <title>", "what the bot works toward, in a line")
    .option("--description <text>", "what done looks like")
    .option("--priority <p>", "high, medium, or low")
    .option("--status <s>", "active, achieved, or dropped")
    .option("--notes <text>", "progress notes (the bot keeps these too)")
    .option(
      "--review-every <duration>",
      "how often the bot reviews it: 12h, 7d, or seconds (at least 1h)",
    )
    .option("--no-review-every", "never ask for a review")
    .option("--position <n>", "order among goals of the same priority");
}

/**
 * Render a goal for a person.
 * @param g - The goal.
 * @returns The text.
 */
export function renderGoal(g: Goal): string {
  return [
    `${g.title}  ${dim(`#${g.id}`)}`,
    `status    ${g.status}`,
    `priority  ${g.priority}`,
    `review    ${reviewText(g.reviewEverySeconds)}${g.reviewDue ? " — due" : ""}${g.lastReviewedAt ? ` (last ${when(g.lastReviewedAt)})` : ""}`,
    ...(g.description ? ["", g.description] : []),
    ...(g.notes ? ["", `Notes: ${g.notes}`] : []),
  ].join("\n");
}

/**
 * Register `goal list|view|add|edit|remove`.
 * @param program - The root command.
 */
export function registerGoalCommands(program: Command): void {
  const goal = program
    .command("goal")
    .description("What a bot works toward: list|view|add|edit|remove");

  withPaging(
    goal
      .command("list")
      .description("List a bot's goals")
      .requiredOption("--bot <bot>", "the bot's id or slug")
      .option("--status <s>", "only active, achieved, or dropped goals"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot: string; status?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<Paginated<"goals", Goal>>(
        "GET",
        `/project/${projectId}/bot/${botId}/goals`,
        {
          query: {
            ...pageQuery(this),
            ...(o.status
              ? { status: oneOf(o.status, STATUSES, "--status") }
              : {}),
          },
        },
      );
      emit(ctx, result, () =>
        result.goals.length === 0
          ? "No goals. `hypotenuse goal add --bot <bot> --title <t>` adds one."
          : table(
              result.goals.map((g) => ({
                id: g.id,
                title: g.title,
                status: g.status,
                priority: g.priority,
                review: `${reviewText(g.reviewEverySeconds)}${g.reviewDue ? " (due)" : ""}`,
                notes: g.notes.replace(/\s+/g, " "),
              })),
              [
                { key: "id" },
                { key: "title", maxWidth: 40 },
                { key: "status" },
                { key: "priority" },
                { key: "review" },
                { key: "notes", maxWidth: 40 },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  goal
    .command("view")
    .description("Show one goal")
    .argument("<goal>", "the goal's id")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ goal: Goal }>(
          "GET",
          `/project/${projectId}/goal/${parseNumber(id, "<goal>")}`,
        );
        emit(ctx, result, () => renderGoal(result.goal));
      });
    });

  withGoalFlags(
    goal
      .command("add")
      .description("Give a bot a goal (write access to the bot)")
      .requiredOption("--bot <bot>", "the bot's id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as GoalFlags & { bot: string };
      if (!o.title) throw new Error("A goal needs --title.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<{ goal: Goal }>(
        "PUT",
        `/project/${projectId}/bot/${botId}/goal`,
        { body: goalBody(o) },
      );
      emit(
        ctx,
        result,
        () => `Added goal #${result.goal.id}: ${result.goal.title}`,
      );
    });
  });

  withGoalFlags(
    goal
      .command("edit")
      .description("Change a goal; only the flags given change")
      .argument("<goal>", "the goal's id"),
  ).action(async function (this: Command, id: string) {
    await runCommand(this, async (ctx) => {
      const body = goalBody(this.opts() as GoalFlags);
      if (Object.keys(body).length === 0) throw new Error("Nothing to change.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<{ goal: Goal }>(
        "POST",
        `/project/${projectId}/goal/${parseNumber(id, "<goal>")}`,
        { body },
      );
      emit(ctx, result, () => renderGoal(result.goal));
    });
  });

  goal
    .command("remove")
    .description(
      "Delete a goal (to keep it on record, set --status achieved or dropped instead)",
    )
    .argument("<goal>", "the goal's id")
    .option("--yes", "confirm")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        requireYes(this, "Deleting a goal needs --yes.");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ goal: Goal }>(
          "DELETE",
          `/project/${projectId}/goal/${parseNumber(id, "<goal>")}`,
        );
        emit(ctx, result, () => `Deleted goal "${result.goal.title}"`);
      });
    });
}
