/**
 * `hypotenuse schedule` — when a bot works without being asked
 * (`schedule:*`). People create, change, arm, and delete schedules; a bot
 * may only propose one, which stays disabled until a person enables it.
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
import { parseNumber } from "../input";
import { dim, table } from "../output/theme";

/** A schedule as the schedule actions answer it. */
export interface Schedule {
  id: number;
  botId: number;
  name: string;
  kind: "instruction" | "goal-review";
  targetType: "channel" | "conversation" | "none";
  channelId: number | null;
  conversationId: number | null;
  cron: string;
  timeZone: string;
  description: string;
  instruction: string;
  guard: string | null;
  catchUp: "latest" | "none";
  enabled: boolean;
  proposedByBot: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  nextSlots?: number[];
}

/** One run of a schedule. */
export interface ScheduleRun {
  id: number;
  slot: number;
  trigger: "cron" | "manual";
  status: string;
  reason: string | null;
  conversationId: number | null;
  costUsd: number | null;
}

const KINDS = ["instruction", "goal-review"];
const TARGETS = ["channel", "conversation", "none"];
const CATCH_UPS = ["latest", "none"];

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
export interface ScheduleFlags {
  name?: string;
  kind?: string;
  target?: string;
  channel?: string;
  conversation?: string;
  cron?: string;
  tz?: string;
  instruction?: string;
  guard?: string | false;
  catchUp?: string;
}

/**
 * The body `add` and `edit` send, from their flags.
 * @param o - The flags.
 * @returns The request body.
 */
export function scheduleBody(o: ScheduleFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (o.name !== undefined) body.name = o.name;
  if (o.kind !== undefined) body.kind = oneOf(o.kind, KINDS, "--kind");
  if (o.target !== undefined)
    body.targetType = oneOf(o.target, TARGETS, "--target");
  if (o.channel !== undefined)
    body.channelId = parseNumber(o.channel, "--channel");
  if (o.conversation !== undefined)
    body.conversationId = parseNumber(o.conversation, "--conversation");
  if (o.cron !== undefined) body.cron = o.cron;
  if (o.tz !== undefined) body.timeZone = o.tz;
  if (o.instruction !== undefined) body.instruction = o.instruction;
  if (o.guard === false) body.guard = null;
  else if (o.guard !== undefined) body.guard = o.guard;
  if (o.catchUp !== undefined)
    body.catchUp = oneOf(o.catchUp, CATCH_UPS, "--catch-up");
  return body;
}

/**
 * Add the flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withScheduleFlags(command: Command): Command {
  return command
    .option("--name <name>", "a short label, e.g. 'Monday summary'")
    .option("--kind <kind>", "instruction (default) or goal-review")
    .option(
      "--target <target>",
      "channel (a new conversation each slot), conversation (a turn in one), or none",
    )
    .option("--channel <id>", "the channel, for --target channel")
    .option(
      "--conversation <id>",
      "the conversation, for --target conversation",
    )
    .option(
      "--cron <expr>",
      "five cron fields, e.g. '0 9 * * 1' (at least 5 minutes apart)",
    )
    .option("--tz <zone>", "the IANA time zone the cron is read in (UTC)")
    .option("--instruction <text>", "what the bot should do at each slot")
    .option(
      "--guard <text>",
      "run only if this holds, checked by the bot's fast model per slot",
    )
    .option("--no-guard", "remove the guard")
    .option("--catch-up <rule>", "after downtime: latest (default) or none");
}

/**
 * A target in a few words.
 * @param s - The schedule.
 * @returns The phrase.
 */
export function targetText(s: Schedule): string {
  if (s.targetType === "channel") return `channel #${s.channelId}`;
  if (s.targetType === "conversation")
    return `conversation #${s.conversationId}`;
  return "none";
}

/**
 * Render a schedule for a person.
 * @param s - The schedule.
 * @returns The text.
 */
export function renderSchedule(s: Schedule): string {
  return [
    `${s.name}  ${dim(`#${s.id}`)}${s.proposedByBot ? "  (proposed by the bot)" : ""}`,
    `when      ${s.description} (${s.timeZone})  ${dim(s.cron)}`,
    `state     ${s.enabled ? "enabled" : "disabled"}${s.nextRunAt ? ` — next ${when(s.nextRunAt)}` : ""}`,
    `kind      ${s.kind}`,
    `target    ${targetText(s)}`,
    `catch-up  ${s.catchUp}`,
    ...(s.guard ? [`guard     ${s.guard}`] : []),
    ...(s.instruction ? ["", s.instruction] : []),
    ...(s.nextSlots?.length
      ? [
          "",
          "Next slots:",
          ...s.nextSlots.map((ms) => `  ${new Date(ms).toISOString()}`),
        ]
      : []),
  ].join("\n");
}

/**
 * Register `schedule list|view|add|edit|enable|disable|run|runs|remove`.
 * @param program - The root command.
 */
export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command("schedule")
    .description(
      "When a bot works without being asked: list|view|add|edit|enable|disable|run|runs|remove",
    );

  withPaging(
    schedule
      .command("list")
      .description("List a bot's schedules, proposals included")
      .requiredOption("--bot <bot>", "the bot's id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<Paginated<"schedules", Schedule>>(
        "GET",
        `/project/${projectId}/bot/${botId}/schedules`,
        { query: pageQuery(this) },
      );
      emit(ctx, result, () =>
        result.schedules.length === 0
          ? "No schedules. `hypotenuse schedule add --bot <bot> --name <n> --cron <expr> --instruction <text>` adds one."
          : table(
              result.schedules.map((s) => ({
                id: s.id,
                name: s.name,
                when: `${s.description} (${s.timeZone})`,
                target: targetText(s),
                state: `${s.enabled ? "enabled" : "disabled"}${s.proposedByBot ? ", proposed" : ""}`,
                next: s.nextRunAt ? when(s.nextRunAt) : "",
              })),
              [
                { key: "id" },
                { key: "name", maxWidth: 30 },
                { key: "when", maxWidth: 40 },
                { key: "target" },
                { key: "state" },
                { key: "next" },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  schedule
    .command("view")
    .description("Show one schedule and its next five slots")
    .argument("<schedule>", "the schedule's id")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ schedule: Schedule }>(
          "GET",
          `/project/${projectId}/schedule/${parseNumber(id, "<schedule>")}`,
        );
        emit(ctx, result, () => renderSchedule(result.schedule));
      });
    });

  withScheduleFlags(
    schedule
      .command("add")
      .description("Attach a schedule to a bot (write access to the bot)")
      .requiredOption("--bot <bot>", "the bot's id or slug")
      .option("--disabled", "save it without arming it"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as ScheduleFlags & {
        bot: string;
        disabled?: boolean;
      };
      if (!o.name) throw new Error("A schedule needs --name.");
      if (!o.cron) throw new Error("A schedule needs --cron.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<{ schedule: Schedule }>(
        "PUT",
        `/project/${projectId}/bot/${botId}/schedule`,
        {
          body: {
            targetType: "none",
            ...scheduleBody(o),
            ...(o.disabled ? { enabled: false } : {}),
          },
        },
      );
      emit(ctx, result, () => renderSchedule(result.schedule));
    });
  });

  withScheduleFlags(
    schedule
      .command("edit")
      .description("Change a schedule; only the flags given change")
      .argument("<schedule>", "the schedule's id"),
  ).action(async function (this: Command, id: string) {
    await runCommand(this, async (ctx) => {
      const body = scheduleBody(this.opts() as ScheduleFlags);
      if (Object.keys(body).length === 0) throw new Error("Nothing to change.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<{ schedule: Schedule }>(
        "POST",
        `/project/${projectId}/schedule/${parseNumber(id, "<schedule>")}`,
        { body },
      );
      emit(ctx, result, () => renderSchedule(result.schedule));
    });
  });

  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    schedule
      .command(verb)
      .description(
        enabled
          ? "Arm a schedule — how a bot's proposal starts running"
          : "Stop a schedule firing, keeping it",
      )
      .argument("<schedule>", "the schedule's id")
      .action(async function (this: Command, id: string) {
        await runCommand(this, async (ctx) => {
          const client = ctx.signedInClient();
          const projectId = await ctx.projectId();
          const result = await client.request<{ schedule: Schedule }>(
            "POST",
            `/project/${projectId}/schedule/${parseNumber(id, "<schedule>")}`,
            { body: { enabled } },
          );
          emit(
            ctx,
            result,
            () =>
              `${enabled ? "Enabled" : "Disabled"} "${result.schedule.name}"${result.schedule.nextRunAt ? ` — next ${when(result.schedule.nextRunAt)}` : ""}`,
          );
        });
      });
  }

  schedule
    .command("run")
    .description(
      "Run a schedule once now, outside its cron (works on a disabled one)",
    )
    .argument("<schedule>", "the schedule's id")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const scheduleId = parseNumber(id, "<schedule>");
        const result = await client.request<{ run: ScheduleRun }>(
          "POST",
          `/project/${projectId}/schedule/${scheduleId}/run`,
        );
        emit(
          ctx,
          result,
          () =>
            `Started run #${result.run.id}. \`hypotenuse schedule runs ${scheduleId}\` shows how it went.`,
        );
      });
    });

  withPaging(
    schedule
      .command("runs")
      .description("A schedule's runs, newest first")
      .argument("<schedule>", "the schedule's id"),
  ).action(async function (this: Command, id: string) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<Paginated<"runs", ScheduleRun>>(
        "GET",
        `/project/${projectId}/schedule/${parseNumber(id, "<schedule>")}/runs`,
        { query: pageQuery(this) },
      );
      emit(ctx, result, () =>
        result.runs.length === 0
          ? "No runs yet."
          : table(
              result.runs.map((r) => ({
                id: r.id,
                slot: new Date(r.slot).toISOString(),
                status: `${r.status}${r.trigger === "manual" ? " (run now)" : ""}`,
                conversation: r.conversationId ?? "",
                reason: r.reason ?? "",
              })),
              [
                { key: "id" },
                { key: "slot" },
                { key: "status" },
                { key: "conversation" },
                { key: "reason", maxWidth: 50 },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  schedule
    .command("remove")
    .description("Delete a schedule and its runs (to pause it, disable it)")
    .argument("<schedule>", "the schedule's id")
    .option("--yes", "confirm")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        requireYes(this, "Deleting a schedule needs --yes.");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ schedule: Schedule }>(
          "DELETE",
          `/project/${projectId}/schedule/${parseNumber(id, "<schedule>")}`,
        );
        emit(ctx, result, () => `Deleted schedule "${result.schedule.name}"`);
      });
    });
}
