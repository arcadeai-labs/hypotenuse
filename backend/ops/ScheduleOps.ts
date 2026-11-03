import { generateText, Output } from "ai";
import { Cron } from "croner";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/schedules";
import { type Bot, bots } from "../schema/bots";
import { type Channel, channels } from "../schema/channels";
import { type Conversation, conversations } from "../schema/conversations";
import { goals } from "../schema/goals";
import { memoryDocuments } from "../schema/memory_documents";
import {
  type GuardDecision,
  type ScheduleRun,
  type ScheduleRunTrigger,
  scheduleRuns,
} from "../schema/schedule_runs";
import {
  SCHEDULE_CATCH_UPS,
  SCHEDULE_KINDS,
  SCHEDULE_TARGET_TYPES,
  type Schedule,
  type ScheduleTargetType,
  schedules,
} from "../schema/schedules";
import { bindingFor } from "./ChannelOps";
import {
  enqueueTick,
  lockConversation,
  pingConversation,
  receiveMessage,
} from "./ConversationOps";
import { reportedCostUsd } from "./CostOps";
import type { DbHandle } from "./DbOps";
import { languageModel } from "./ModelOps";
import { PENDING_THREAD_PREFIX } from "./ScheduleRunOps";
import { installationFor } from "./SurfaceOps";

/**
 * **Schedules**: cron decides *when* a bot wakes, and an optional guard — one
 * question to the bot's `fast` model per slot — decides *whether*.
 *
 * The path of one slot:
 *
 * 1. `schedules:due` (a clock) claims schedules whose `nextRunAt` has passed
 *    (`FOR UPDATE SKIP LOCKED`), writes one `schedule_runs` row per
 *    `(scheduleId, slot)` under a unique index, advances `nextRunAt`, and
 *    enqueues `schedule-run:fire` after commit.
 * 2. `schedule-run:fire` takes the run by a conditional update (never a held
 *    row lock, so it cannot deadlock with a tick), checks the target is still
 *    engaged, asks the guard if there is one, and wakes the target with an
 *    inbox row keyed `schedule:<id>:<slotIso>` (`source: "schedule"`).
 * 3. The turn that reads that row settles the run (`ScheduleRunOps`).
 *
 * | Target | Each slot |
 * |---|---|
 * | `channel` | a new conversation in the channel, keyed `schedule:<id>:<slotIso>`, a pending thread: its first final message opens the platform's thread (a Slack top-level message whose `ts` becomes the key) |
 * | `conversation` | a turn in that conversation |
 * | `none` | a new conversation in the bot's internal `schedules` channel (`web`): memory and goals only, nothing posted to a platform |
 *
 * **Disengagement** — a slot skips, with the reason, when:
 *
 * | Target state | Reason |
 * |---|---|
 * | the bot is disabled | `The bot is disabled.` |
 * | a cron slot of a schedule disabled since it was claimed | `The schedule was disabled.` |
 * | a channel archived | `The channel is archived.` |
 * | a platform channel with no enabled binding for the bot | `The bot is no longer bound to this channel.` |
 * | a platform channel whose installation is not active | `The bot's <type> app is not installed.` |
 * | a conversation a person stopped (`ended`, `cancelled`) | `A person stopped this conversation.` |
 * | a Linear conversation that ended (its session is terminal) | `The Linear session has ended.` |
 *
 * A schedule's missed slots never burst: `catchUp: latest` runs the newest
 * missed slot, `none` runs a slot only while it is no more than
 * `lateGraceMs` late. Slots are computed by croner in the schedule's zone:
 * a time a DST gap skips runs once at the shifted time, and a time a DST
 * overlap repeats runs once.
 */

/** The channel types a `channel` target may name. */
export const SCHEDULE_CHANNEL_TYPES = ["slack", "webhook", "web"] as const;

/** The instruction a `goal-review` schedule runs with when it names none. */
export const GOAL_REVIEW_INSTRUCTION =
  "Review each of your active goals against what you have done recently. For each one, call goal_update with where it stands — achieved, dropped, or still active with fresh notes. Post a short summary only if something changed or needs a person; otherwise end silently.";

/** The Zod input for a schedule's name. */
export const scheduleNameInput = z
  .string()
  .trim()
  .min(1, "A schedule needs a name")
  .max(100)
  .describe("A short label for people, e.g. Monday issue summary");

/** The Zod input for a cron expression. */
export const cronInput = z
  .string()
  .trim()
  .min(9)
  .max(200)
  .describe(
    "Five cron fields — minute hour day-of-month month day-of-week — read in timeZone, e.g. 0 9 * * 1 for Mondays at 09:00. At least 5 minutes between slots",
  );

/** The Zod input for an IANA time zone. */
export const timeZoneInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    "The IANA time zone the cron fields are read in, e.g. Europe/Berlin",
  );

/** The Zod input for a schedule's instruction. */
export const instructionInput = z
  .string()
  .trim()
  .max(4_000)
  .describe("What the bot should do at each slot, as you would ask it");

/** The Zod input for a schedule's guard. */
export const guardInput = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .nullable()
  .describe(
    "Optional: a condition the bot's fast model checks once per slot before the bot wakes, e.g. only if there are new P0 issues; null for none",
  );

/** The Zod input for a schedule's kind. */
export const scheduleKindInput = z
  .enum(SCHEDULE_KINDS)
  .describe(
    "instruction (follow the instruction) or goal-review (review the bot's goals and recent conversations)",
  );

/** The Zod input for a schedule's target type. */
export const targetTypeInput = z
  .enum(SCHEDULE_TARGET_TYPES)
  .describe(
    "channel (a new conversation in channelId each slot), conversation (a turn in conversationId), or none (memory and goals only, nothing posted)",
  );

/** The Zod input for a schedule's catch-up rule. */
export const catchUpInput = z
  .enum(SCHEDULE_CATCH_UPS)
  .describe(
    "After downtime: latest (run the newest missed slot once) or none (skip missed slots)",
  );

/**
 * A parameter refusal keyed on the input that caused it.
 * @param key - The input.
 * @param message - What is wrong and what to send instead.
 * @returns The error.
 */
function invalid(key: string, message: string): TypedError {
  return new TypedError({
    message,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key,
  });
}

/**
 * The refusal for an `instruction` schedule with nothing to do.
 * @returns The error, keyed on `instruction`.
 */
export function instructionRequired(): TypedError {
  return invalid(
    "instruction",
    "An instruction schedule needs an instruction: what the bot should do at each slot.",
  );
}

/**
 * Parse a cron expression in a time zone, refusing what cannot run.
 * @param cron - Five fields.
 * @param timeZone - An IANA zone.
 * @returns The parsed schedule, paused (it never runs a callback).
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` on `cron` or `timeZone`.
 */
export function parseCron(cron: string, timeZone: string): Cron {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw invalid(
      "timeZone",
      `"${timeZone}" is not an IANA time zone. Send one like America/New_York or UTC.`,
    );
  }
  try {
    return new Cron(cron, { timezone: timeZone, paused: true, mode: "5-part" });
  } catch (e) {
    throw invalid(
      "cron",
      `That cron expression does not parse: ${e instanceof Error ? e.message.replace(/^CronPattern: /, "") : String(e)}. Send five fields, e.g. 0 9 * * 1.`,
    );
  }
}

/**
 * Check a cron expression can run here: it has a next slot, and no two of its
 * upcoming slots are closer than the minimum interval.
 * @param cron - Five fields.
 * @param timeZone - An IANA zone.
 * @param after - From when.
 * @returns The next slot.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` on `cron`.
 */
export function assertRunnableCron(
  cron: string,
  timeZone: string,
  after: Date = new Date(),
): Date {
  const parsed = parseCron(cron, timeZone);
  const slots = parsed.nextRuns(200, after);
  if (slots.length === 0) {
    throw invalid(
      "cron",
      "That cron expression has no future slot. Send one that runs again.",
    );
  }
  const min = config.schedules.minIntervalMs;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].getTime() - slots[i - 1].getTime() < min) {
      throw invalid(
        "cron",
        `Slots must be at least ${Math.round(min / 60_000)} minutes apart; that expression runs at ${slots[i - 1].toISOString()} and again at ${slots[i].toISOString()}.`,
      );
    }
  }
  return slots[0];
}

/**
 * The next slot strictly after a time.
 * @param cron - Five fields.
 * @param timeZone - An IANA zone.
 * @param after - From when.
 * @returns The slot, or `null` when the expression never runs again.
 */
export function nextSlot(
  cron: string,
  timeZone: string,
  after: Date,
): Date | null {
  return parseCron(cron, timeZone).nextRun(after);
}

/**
 * The next few slots after a time.
 * @param cron - Five fields.
 * @param timeZone - An IANA zone.
 * @param n - How many.
 * @param after - From when.
 * @returns The slots.
 */
export function upcomingSlots(
  cron: string,
  timeZone: string,
  n: number,
  after: Date = new Date(),
): Date[] {
  return parseCron(cron, timeZone).nextRuns(n, after);
}

/**
 * The newest slot at or before a time.
 * @param cron - Five fields.
 * @param timeZone - An IANA zone.
 * @param at - The time.
 * @returns The slot, or `null`.
 */
export function latestSlot(
  cron: string,
  timeZone: string,
  at: Date,
): Date | null {
  const [slot] = parseCron(cron, timeZone).previousRuns(
    1,
    new Date(at.getTime() + 1),
  );
  return slot ?? null;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * A cron expression in words, for the common shapes; anything else is said
 * as itself.
 * @param cron - Five fields.
 * @returns A phrase, e.g. "Mondays at 09:00".
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron ${cron}`;
  const [min, hour, dom, mon, dow] = parts;
  const num = (s: string) => /^\d+$/.test(s);
  const at = () => `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const step = /^\*\/(\d+)$/;
  if (dom === "*" && mon === "*" && dow === "*") {
    if (step.test(min) && hour === "*") {
      return `Every ${min.match(step)?.[1]} minutes`;
    }
    if (num(min) && hour === "*")
      return `Every hour at :${min.padStart(2, "0")}`;
    if (num(min) && step.test(hour)) {
      return `Every ${hour.match(step)?.[1]} hours at :${min.padStart(2, "0")}`;
    }
    if (num(min) && num(hour)) return `Every day at ${at()}`;
  }
  if (num(min) && num(hour) && dom === "*" && mon === "*") {
    if (dow === "1-5") return `Weekdays at ${at()}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${at()}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = dow.split(",").map((d) => `${WEEKDAYS[Number(d) % 7]}s`);
      return `${days.join(", ")} at ${at()}`;
    }
  }
  if (num(min) && num(hour) && num(dom) && mon === "*" && dow === "*") {
    return `Day ${dom} of every month at ${at()}`;
  }
  return `cron ${cron}`;
}

/**
 * Shape a schedule for any answer. Timestamps are epoch ms.
 * @param s - The row.
 * @param extra.nextSlots - Include this many upcoming slots.
 * @returns The serialized schedule.
 */
export function serializeSchedule(
  s: Schedule,
  extra: { nextSlots?: number } = {},
) {
  let upcoming: number[] | undefined;
  if (extra.nextSlots) {
    try {
      upcoming = upcomingSlots(
        s.cron,
        s.timeZone,
        extra.nextSlots,
        new Date(),
      ).map((d) => d.getTime());
    } catch {
      upcoming = [];
    }
  }
  return {
    id: s.id,
    projectId: s.projectId,
    botId: s.botId,
    name: s.name,
    kind: s.kind,
    targetType: s.targetType,
    channelId: s.channelId,
    conversationId: s.conversationId,
    cron: s.cron,
    timeZone: s.timeZone,
    description: describeCron(s.cron),
    instruction: s.instruction,
    guard: s.guard,
    catchUp: s.catchUp,
    enabled: s.enabled,
    proposedByBot: s.proposedByBot,
    proposedInConversationId: s.proposedInConversationId,
    nextRunAt: s.enabled ? s.nextRunAt.getTime() : null,
    lastRunAt: s.lastRunAt?.getTime() ?? null,
    ...(upcoming ? { nextSlots: upcoming } : {}),
    createdByUserId: s.createdByUserId,
    createdAt: s.createdAt.getTime(),
    updatedAt: s.updatedAt.getTime(),
  };
}

/**
 * Shape a run for any answer.
 * @param r - The row.
 * @returns The serialized run.
 */
export function serializeScheduleRun(r: ScheduleRun) {
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    botId: r.botId,
    slot: r.slot.getTime(),
    trigger: r.trigger,
    status: r.status,
    reason: r.reason,
    conversationId: r.conversationId,
    guard: r.guard,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    triggeredByUserId: r.triggeredByUserId,
    createdAt: r.createdAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
  };
}

/**
 * The 404 for a schedule that is missing or whose bot the caller cannot read.
 * @returns The error.
 */
export function scheduleNotFound(): TypedError {
  return new TypedError({
    message: "Schedule not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a schedule of a project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param scheduleId - The schedule.
 * @param options.lock - Take its row lock.
 * @returns The schedule.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadSchedule(
  db: DbHandle,
  projectId: number,
  scheduleId: number,
  options: { lock?: boolean } = {},
): Promise<Schedule> {
  const query = db
    .select()
    .from(schedules)
    .where(
      and(eq(schedules.id, scheduleId), eq(schedules.projectId, projectId)),
    );
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) throw scheduleNotFound();
  return row;
}

/**
 * Refuse a new schedule past the bot's limit.
 * @param db - A database handle.
 * @param botId - The bot.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the limit.
 */
export async function assertUnderLimit(
  db: DbHandle,
  botId: number,
): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(schedules)
    .where(eq(schedules.botId, botId));
  const max = config.schedules.maxPerBot;
  if ((row?.n ?? 0) >= max) {
    throw invalid(
      "botId",
      `A bot may have at most ${max} schedules, proposed ones included. Delete one first.`,
    );
  }
}

/** A target as an action or tool names it. */
export interface TargetInput {
  targetType: ScheduleTargetType;
  channelId?: number | null;
  conversationId?: number | null;
}

/**
 * Check a schedule's target belongs to its bot and can take scheduled turns.
 * @param db - A database handle.
 * @param bot - The schedule's bot.
 * @param target - What was asked for.
 * @returns The columns to store.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the input.
 */
export async function resolveTarget(
  db: DbHandle,
  bot: Bot,
  target: TargetInput,
): Promise<{ channelId: number | null; conversationId: number | null }> {
  if (target.targetType === "none") {
    return { channelId: null, conversationId: null };
  }
  if (target.targetType === "channel") {
    if (!target.channelId) {
      throw invalid("channelId", "A channel target needs channelId.");
    }
    const [channel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, target.channelId),
          eq(channels.projectId, bot.projectId),
        ),
      )
      .limit(1);
    if (!channel || (channel.botId !== null && channel.botId !== bot.id)) {
      throw invalid("channelId", "No such channel in this project.");
    }
    if (!(SCHEDULE_CHANNEL_TYPES as readonly string[]).includes(channel.type)) {
      throw invalid(
        "channelId",
        channel.type === "linear" || channel.type === "pylon"
          ? `A ${channel.type} channel has no place to start a conversation of its own. Target one of the bot's conversations there instead, or none.`
          : `A ${channel.type} channel cannot take a scheduled conversation. Target a Slack, webhook, or dashboard channel, a conversation, or none.`,
      );
    }
    if (channel.type !== "web") {
      const binding = await bindingFor(db, bot.id, channel.id);
      if (!binding) {
        throw invalid(
          "channelId",
          "The bot is not bound to that channel. Bind it first, then schedule it there.",
        );
      }
    }
    return { channelId: channel.id, conversationId: null };
  }
  if (!target.conversationId) {
    throw invalid(
      "conversationId",
      "A conversation target needs conversationId.",
    );
  }
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, target.conversationId),
        eq(conversations.botId, bot.id),
      ),
    )
    .limit(1);
  if (!conversation) {
    throw invalid("conversationId", "That bot has no such conversation.");
  }
  return { channelId: null, conversationId: conversation.id };
}

/**
 * Find or create a bot's internal `schedules` channel, where a `none`
 * target's conversations live.
 * @param tx - An open transaction.
 * @param bot - The bot.
 * @returns The channel.
 */
export async function upsertScheduleChannel(
  tx: DbHandle,
  bot: Bot,
): Promise<Channel> {
  const externalId = `bot:${bot.id}:schedules`;
  await tx
    .insert(channels)
    .values({
      projectId: bot.projectId,
      type: "web",
      externalId,
      botId: bot.id,
      name: "schedules",
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.projectId, bot.projectId),
        eq(channels.type, "web"),
        eq(channels.externalId, externalId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Why a slot cannot wake its target now, or `null` when it can. See the
 * disengagement table above.
 * @param db - A database handle.
 * @param schedule - The schedule.
 * @param bot - Its bot.
 * @param trigger - What wrote the run.
 * @returns The reason, or `null`.
 */
export async function disengagedReason(
  db: DbHandle,
  schedule: Schedule,
  bot: Bot,
  trigger: ScheduleRunTrigger,
): Promise<string | null> {
  if (!bot.enabled) return "The bot is disabled.";
  if (trigger === "cron" && !schedule.enabled) {
    return "The schedule was disabled.";
  }
  if (schedule.targetType === "none") return null;
  let channel: Channel | undefined;
  if (schedule.targetType === "conversation") {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, schedule.conversationId ?? 0))
      .limit(1);
    if (!conversation) return "The conversation is gone.";
    if (
      conversation.state === "ended" &&
      conversation.outcome === "cancelled"
    ) {
      return "A person stopped this conversation.";
    }
    [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, conversation.channelId))
      .limit(1);
    if (channel?.type === "linear" && conversation.state === "ended") {
      return "The Linear session has ended.";
    }
  } else {
    [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, schedule.channelId ?? 0))
      .limit(1);
  }
  if (!channel) return "The channel is gone.";
  if (channel.archived) return "The channel is archived.";
  if (channel.type === "api" || channel.type === "web") return null;
  const binding = await bindingFor(db, bot.id, channel.id);
  if (!binding?.enabled) return "The bot is no longer bound to this channel.";
  const installation = await installationFor(db, bot.id, channel);
  if (installation?.status !== "active") {
    return `The bot's ${channel.type} app is not installed.`;
  }
  return null;
}

/** The guard's answer the fast model must give. */
const guardSchema = z.object({
  act: z.boolean(),
  reason: z.string().max(500),
});

/** What the guard model is told. */
const GUARD_INSTRUCTIONS = `You decide whether a scheduled task should run now. You are given the task's instruction, a condition, and some context the bot has. Answer act: true only if the condition holds (or plausibly holds and checking is the task itself); otherwise act: false. Give a one-sentence reason. You cannot use tools.`;

/**
 * Ask the bot's `fast` model whether a guarded slot should wake the bot:
 * one call per slot, with cheap context — the goals and the channel's
 * memory titles.
 * @param bot - The bot.
 * @param schedule - The schedule.
 * @param slot - The slot.
 * @returns The decision and what it cost, where the provider said.
 * @throws When the model cannot be called or does not answer.
 */
export async function evaluateGuard(
  bot: Bot,
  schedule: Schedule,
  slot: Date,
): Promise<{ decision: GuardDecision; costUsd: number | null }> {
  const fast = await languageModel(bot.projectId, bot.fastModelAlias);
  const context = await guardContext(bot, schedule);
  const result = await generateText({
    model: fast.model,
    instructions: GUARD_INSTRUCTIONS,
    prompt: [
      `Now: ${slot.toISOString()} (${schedule.timeZone}).`,
      `Instruction: ${schedule.instruction || GOAL_REVIEW_INSTRUCTION}`,
      `Condition: ${schedule.guard}`,
      context,
    ].join("\n\n"),
    output: Output.object({ schema: guardSchema }),
    maxRetries: 1,
  });
  return {
    decision: { act: result.output.act, reason: result.output.reason },
    costUsd: reportedCostUsd(result.providerMetadata),
  };
}

/**
 * The cheap context a guard reads: the bot's active goals and the titles of
 * its target channel's memory.
 * @param bot - The bot.
 * @param schedule - The schedule.
 * @returns Markdown.
 */
async function guardContext(bot: Bot, schedule: Schedule): Promise<string> {
  const db = api.db.db;
  const active = await db
    .select({ title: goals.title, notes: goals.notes })
    .from(goals)
    .where(and(eq(goals.botId, bot.id), eq(goals.status, "active")))
    .orderBy(asc(goals.position), asc(goals.id))
    .limit(20);
  let channelId = schedule.channelId;
  if (schedule.conversationId) {
    const [c] = await db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, schedule.conversationId));
    channelId = c?.channelId ?? null;
  }
  const memory = channelId
    ? await db
        .select({
          path: memoryDocuments.logicalPath,
          description: memoryDocuments.description,
        })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.channelId, channelId),
            eq(memoryDocuments.scope, "channel"),
            eq(memoryDocuments.isCurrent, true),
            eq(memoryDocuments.tombstone, false),
          ),
        )
        .orderBy(desc(memoryDocuments.createdAt))
        .limit(15)
    : [];
  return [
    "The bot's active goals:",
    active.length
      ? active
          .map(
            (g) =>
              `- ${g.title}${g.notes ? ` — ${g.notes.slice(0, 200)}` : ""}`,
          )
          .join("\n")
      : "(none)",
    "What the bot remembers about this channel:",
    memory.length
      ? memory
          .map((m) => `- ${m.path}${m.description ? `: ${m.description}` : ""}`)
          .join("\n")
      : "(nothing)",
  ].join("\n");
}

/**
 * The message a scheduled turn starts with: what woke the bot, the
 * instruction, its active goals, and the silent contract. A `goal-review`
 * adds the bot's recent conversations.
 * @param db - A database handle.
 * @param bot - The bot.
 * @param schedule - The schedule.
 * @param slot - The slot.
 * @returns Markdown.
 */
export async function scheduleMessage(
  db: DbHandle,
  bot: Bot,
  schedule: Schedule,
  slot: Date,
): Promise<string> {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(slot);
  const active = await db
    .select()
    .from(goals)
    .where(and(eq(goals.botId, bot.id), eq(goals.status, "active")))
    .orderBy(asc(goals.position), asc(goals.id))
    .limit(30);
  const lines = [
    `**Scheduled: ${schedule.name}** — ${local} (${schedule.timeZone}). A schedule started this turn, not a person.`,
    "",
    `Instruction: ${schedule.instruction || (schedule.kind === "goal-review" ? GOAL_REVIEW_INSTRUCTION : "(none)")}`,
    "",
    "Your active goals:",
    ...(active.length
      ? active.map(
          (g) =>
            `- #${g.id} [${g.priority}] ${g.title}${g.notes ? ` — ${g.notes.slice(0, 300)}` : ""}`,
        )
      : ["- (none)"]),
  ];
  if (schedule.kind === "goal-review") {
    const since = new Date(slot.getTime() - 7 * 86_400_000);
    const recent = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.botId, bot.id),
          gte(conversations.lastActivityAt, since),
        ),
      )
      .orderBy(desc(conversations.lastActivityAt))
      .limit(10);
    lines.push(
      "",
      "Your conversations in the last seven days:",
      ...(recent.length
        ? recent.map(
            (c) =>
              `- #${c.id} ${c.title ?? "(untitled)"} — ${c.state}${c.outcome ? ` (${c.outcome})` : ""}, last active ${c.lastActivityAt.toISOString()}`,
          )
        : ["- (none)"]),
    );
  }
  lines.push(
    "",
    "If there is nothing worth saying, end the turn with `complete` and `silent: true`: nothing is posted.",
  );
  return lines.join("\n");
}

/**
 * **Claim due schedules**: in one transaction, lock schedules whose
 * `nextRunAt` has passed (`SKIP LOCKED`, so overlapping clocks share the
 * work), write one run per slot under the unique index, and advance
 * `nextRunAt`. The caller fires the runs after commit.
 * @param now - The time.
 * @returns The runs written.
 */
export async function claimDue(now: Date = new Date()): Promise<number[]> {
  return api.db.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
      .orderBy(asc(schedules.nextRunAt))
      .limit(config.schedules.batchSize)
      .for("update", { skipLocked: true });
    const runIds: number[] = [];
    for (const s of due) {
      let slot: Date | null;
      let next: Date | null;
      try {
        slot = latestSlot(s.cron, s.timeZone, now);
        next = nextSlot(s.cron, s.timeZone, now);
      } catch {
        slot = null;
        next = null;
      }
      if (slot && slot < s.nextRunAt) slot = null;
      // Set only when a run is written: a slot dropped as late never ran.
      let ranAt: Date | null = null;
      const late = slot ? now.getTime() - slot.getTime() : 0;
      if (
        slot &&
        (s.catchUp === "latest" || late <= config.schedules.lateGraceMs)
      ) {
        const [run] = await tx
          .insert(scheduleRuns)
          .values({
            scheduleId: s.id,
            projectId: s.projectId,
            botId: s.botId,
            slot,
            trigger: "cron",
          })
          .onConflictDoNothing()
          .returning({ id: scheduleRuns.id });
        if (run) {
          runIds.push(run.id);
          ranAt = slot;
        }
      }
      await tx
        .update(schedules)
        .set(
          next
            ? {
                nextRunAt: next,
                ...(ranAt ? { lastRunAt: ranAt } : {}),
              }
            : // An expression that never runs again stops here.
              { enabled: false },
        )
        .where(eq(schedules.id, s.id));
    }
    return runIds;
  });
}

/**
 * Runs written but never fired, or whose fire died partway: still `pending`
 * or `guarding` past `staleRunMs`.
 * @param now - The time.
 * @returns Their ids.
 */
export async function staleRuns(now: Date = new Date()): Promise<number[]> {
  const before = new Date(now.getTime() - config.schedules.staleRunMs);
  const rows = await api.db.db
    .select({ id: scheduleRuns.id })
    .from(scheduleRuns)
    .where(
      and(
        inArray(scheduleRuns.status, ["pending", "guarding"]),
        sql`coalesce(${scheduleRuns.startedAt}, ${scheduleRuns.createdAt}) < ${before}`,
      ),
    )
    .orderBy(asc(scheduleRuns.id))
    .limit(config.schedules.batchSize);
  return rows.map((r) => r.id);
}

/**
 * Enqueue the fire of each run. An accelerant: `schedules:due` fires a run
 * whose task was lost.
 * @param runIds - The runs.
 */
export async function enqueueFires(runIds: number[]): Promise<void> {
  for (const runId of runIds) {
    await api.actions.enqueue("schedule-run:fire", { runId }, "agents");
  }
}

/** What one fire did. */
export type FireOutcome =
  | "woken"
  | "skipped"
  | "failed"
  | "busy"
  | "settled"
  | "gone";

/**
 * Finish a run that will wake nothing.
 * @param runId - The run.
 * @param startedAt - The fire's claim, which must still hold.
 * @param status - `skipped` or `failed`.
 * @param reason - Why.
 * @param guard - The guard's answer, if it gave one.
 * @param costUsd - The guard's cost, if reported.
 * @returns Whether this fire still held the run.
 */
async function finishRun(
  runId: number,
  startedAt: Date,
  status: "skipped" | "failed",
  reason: string,
  guard?: GuardDecision,
  costUsd?: number | null,
): Promise<boolean> {
  const [row] = await api.db.db
    .update(scheduleRuns)
    .set({
      status,
      reason,
      finishedAt: new Date(),
      ...(guard ? { guard } : {}),
      ...(costUsd !== undefined && costUsd !== null
        ? { costUsd: String(costUsd) }
        : {}),
    })
    .where(
      and(
        eq(scheduleRuns.id, runId),
        eq(scheduleRuns.startedAt, startedAt),
        inArray(scheduleRuns.status, ["pending", "guarding"]),
      ),
    )
    .returning({ id: scheduleRuns.id });
  return Boolean(row);
}

/**
 * **Fire a run**: take it, check the target, ask the guard, and wake. Safe
 * to call twice for one run: a run is taken by a conditional update on its
 * status and `startedAt`, so a second fire finds it taken (`busy`) or done
 * (`settled`). A fire that died partway leaves `startedAt` behind, and after
 * `staleRunMs` a fire may take the run over.
 *
 * The run is never row-locked while the conversation is: the wake locks the
 * conversation first and then writes the run, the order the tick uses.
 * @param runId - The run.
 * @returns What happened.
 */
export async function fireRun(runId: number): Promise<FireOutcome> {
  const db = api.db.db;
  const [found] = await db
    .select({ run: scheduleRuns, schedule: schedules, bot: bots })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .innerJoin(bots, eq(bots.id, schedules.botId))
    .where(eq(scheduleRuns.id, runId))
    .limit(1);
  if (!found) return "gone";
  const { schedule, bot } = found;
  const staleBefore = new Date(Date.now() - config.schedules.staleRunMs);
  const startedAt = new Date();
  const [taken] = await db
    .update(scheduleRuns)
    .set({
      startedAt,
      status: schedule.guard ? "guarding" : "pending",
    })
    .where(
      and(
        eq(scheduleRuns.id, runId),
        inArray(scheduleRuns.status, ["pending", "guarding"]),
        or(
          isNull(scheduleRuns.startedAt),
          lte(scheduleRuns.startedAt, staleBefore),
        ),
      ),
    )
    .returning();
  if (!taken) {
    const [now] = await db
      .select({ status: scheduleRuns.status })
      .from(scheduleRuns)
      .where(eq(scheduleRuns.id, runId));
    return now && ["pending", "guarding"].includes(now.status)
      ? "busy"
      : "settled";
  }

  const early = await disengagedReason(db, schedule, bot, taken.trigger);
  if (early) {
    await finishRun(runId, startedAt, "skipped", early);
    return "skipped";
  }

  let guard: GuardDecision | undefined;
  let guardCost: number | null = null;
  if (schedule.guard) {
    try {
      const answered = await evaluateGuard(bot, schedule, taken.slot);
      guard = answered.decision;
      guardCost = answered.costUsd;
    } catch (e) {
      await finishRun(
        runId,
        startedAt,
        "failed",
        `The guard could not decide: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      );
      return "failed";
    }
    if (!guard.act) {
      await finishRun(
        runId,
        startedAt,
        "skipped",
        `Guard: ${guard.reason}`,
        guard,
        guardCost,
      );
      return "skipped";
    }
  }

  let outcome: FireOutcome = "busy";
  let woken: Conversation | null = null;
  try {
    await db.transaction(async (tx) => {
      const conversationId = await targetConversation(tx, schedule, bot, taken);
      const locked = await lockConversation(tx, conversationId);
      if (!locked) throw new Error("The conversation is gone.");
      // The real guard: re-check under the conversation's lock, against the
      // schedule as it is now — a person may have disabled it while the
      // guard ran. `FOR SHARE` after the conversation keeps the lock order,
      // and makes a disable that is mid-commit land first.
      const [current] = await tx
        .select()
        .from(schedules)
        .where(eq(schedules.id, schedule.id))
        .for("share");
      if (!current) throw new Error("The schedule is gone.");
      const late = await disengagedReason(
        tx,
        current,
        locked.bot,
        taken.trigger,
      );
      // Roll back the conversation this transaction may have created: a
      // skipped slot leaves no empty thread behind.
      if (late) throw new LateSkip(late);
      const slotIso = taken.slot.toISOString();
      const received = await receiveMessage(tx, locked.conversation, {
        text: await scheduleMessage(tx, bot, schedule, taken.slot),
        delivery: "queue",
        deliveryKey: `schedule:${schedule.id}:${slotIso}`,
        source: "schedule",
        userId: taken.triggeredByUserId,
        metadata: {
          scheduleId: schedule.id,
          scheduleRunId: runId,
          slot: slotIso,
        },
        answers: false,
        wakeReason: "schedule",
      });
      const [marked] = await tx
        .update(scheduleRuns)
        .set({
          status: "woken",
          conversationId,
          inboxId: received.inbox.id,
          ...(guard ? { guard } : {}),
          ...(guardCost !== null ? { costUsd: String(guardCost) } : {}),
        })
        .where(
          and(
            eq(scheduleRuns.id, runId),
            eq(scheduleRuns.startedAt, startedAt),
            inArray(scheduleRuns.status, ["pending", "guarding"]),
          ),
        )
        .returning({ id: scheduleRuns.id });
      // Another fire took the run over: roll back what this one wrote.
      if (!marked) throw new RunTakenOver();
      outcome = "woken";
      woken = received.woke ? received.conversation : null;
    });
  } catch (e) {
    if (e instanceof RunTakenOver) return "busy";
    if (e instanceof LateSkip) {
      await finishRun(runId, startedAt, "skipped", e.message, guard, guardCost);
      return "skipped";
    }
    await finishRun(
      runId,
      startedAt,
      "failed",
      e instanceof Error ? e.message.slice(0, 300) : String(e),
    );
    return "failed";
  }
  const toTick = woken as Conversation | null;
  if (toTick) {
    await enqueueTick(toTick);
    await pingConversation(toTick.projectId, toTick.id);
  }
  return outcome;
}

/** A second fire holds the run; this one's writes are rolled back. */
class RunTakenOver extends Error {}

/** The target disengaged during the fire; the wake's writes are rolled back. */
class LateSkip extends Error {}

/**
 * The conversation a slot works in: the target conversation, or a new one
 * for a `channel` or `none` target, keyed by the slot so a retry finds it.
 * @param tx - The wake's transaction.
 * @param schedule - The schedule.
 * @param bot - Its bot.
 * @param run - The run.
 * @returns The conversation's id.
 */
async function targetConversation(
  tx: DbHandle,
  schedule: Schedule,
  bot: Bot,
  run: ScheduleRun,
): Promise<number> {
  if (schedule.targetType === "conversation") {
    return schedule.conversationId ?? 0;
  }
  const channel =
    schedule.targetType === "none"
      ? await upsertScheduleChannel(tx, bot)
      : (
          await tx
            .select()
            .from(channels)
            .where(eq(channels.id, schedule.channelId ?? 0))
            .limit(1)
        )[0];
  if (!channel) throw new Error("The channel is gone.");
  const key = `${PENDING_THREAD_PREFIX}${schedule.id}:${run.slot.toISOString()}`;
  await tx
    .insert(conversations)
    .values({
      projectId: bot.projectId,
      botId: bot.id,
      channelId: channel.id,
      externalConversationKey: key,
      title: schedule.name,
      state: "hibernating",
      details: {
        schedule: {
          scheduleId: schedule.id,
          scheduleRunId: run.id,
          slot: run.slot.toISOString(),
        },
      },
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.botId, bot.id),
        eq(conversations.channelId, channel.id),
        eq(conversations.externalConversationKey, key),
      ),
    )
    .limit(1);
  return row.id;
}

/**
 * Write a run a person asked for now (`schedule:run-now`), in the caller's
 * transaction. Its slot is the moment asked.
 * @param tx - The audited transaction.
 * @param schedule - The schedule.
 * @param userId - Who asked.
 * @returns The run.
 */
export async function insertManualRun(
  tx: DbHandle,
  schedule: Schedule,
  userId: number | null,
): Promise<ScheduleRun> {
  const [run] = await tx
    .insert(scheduleRuns)
    .values({
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      botId: schedule.botId,
      slot: new Date(),
      trigger: "manual",
      triggeredByUserId: userId,
    })
    .returning();
  return run;
}
