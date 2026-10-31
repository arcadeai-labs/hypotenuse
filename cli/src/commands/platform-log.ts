/**
 * `hypotenuse participant` and `hypotenuse event` — who on a platform has
 * written to the project's bots (`participant:*`), and every platform
 * delivery the bots received with what processing made of it
 * (`trigger-event:*`, project admins only). Both only read.
 */
import type { Command } from "commander";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseNumber } from "../input";
import { table } from "../output/theme";

/** Where a delivery's processing stands. */
export const TRIGGER_EVENT_STATUSES = [
  "pending",
  "processed",
  "ignored",
  "failed",
] as const;

/** A participant as the participant actions answer it. */
interface Participant {
  id: number;
  projectId: number;
  type: string;
  externalWorkspaceId: string;
  externalUserId: string;
  displayName: string;
  isBot: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** A delivery as the trigger-event actions answer it. */
interface TriggerEvent {
  id: number;
  projectId: number;
  type: string;
  botInstallationId: number | null;
  externalEventId: string;
  messageKey: string | null;
  status: (typeof TRIGGER_EVENT_STATUSES)[number];
  outcome: string | null;
  detail: unknown;
  error: string | null;
  attempts: number;
  receivedAt: number;
  processedAt: number | null;
  /** On `trigger-event:view` only: the body as received. */
  payload?: unknown;
}

/**
 * Parse a numeric id a person typed.
 * @param raw - What they typed.
 * @param what - What it names, for the refusal.
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
function idOf(raw: string, what: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${what} is named by its id (a number); got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Register `participant list|view`.
 * @param program - The root program.
 */
export function registerParticipantCommands(program: Command): void {
  const participant = program
    .command("participant")
    .description(
      "People on platforms who have written to the project's bots: list|view",
    );

  withPaging(
    participant
      .command("list")
      .description("List platform people, most recently seen first")
      .option("--type <platform>", "only this platform, e.g. webhook")
      .option("--query <text>", "only names containing this"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { type?: string; query?: string };
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<Paginated<"participants", Participant>>(
          "GET",
          `/project/${projectId}/participants`,
          { query: { ...pageQuery(this), type: o.type, query: o.query } },
        );
      emit(
        ctx,
        result,
        () =>
          table(
            result.participants.map((p) => ({
              id: p.id,
              platform: p.type,
              name: p.isBot ? `${p.displayName} (bot)` : p.displayName,
              "platform id": p.externalUserId,
              workspace: p.externalWorkspaceId,
              "last seen": when(p.lastSeenAt),
            })),
            [
              { key: "id" },
              { key: "platform" },
              { key: "name", maxWidth: 30 },
              { key: "platform id", maxWidth: 30 },
              { key: "workspace", maxWidth: 20 },
              { key: "last seen" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  participant
    .command("view")
    .description("Show one platform person")
    .argument("<participant>", "the participant's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ participant: Participant }>(
            "GET",
            `/project/${projectId}/participant/${idOf(raw, "A participant")}`,
          );
        const p = result.participant;
        emit(ctx, result, () =>
          [
            `${p.displayName}${p.isBot ? " (bot)" : ""} (participant ${p.id})`,
            `platform      ${p.type}`,
            `workspace     ${p.externalWorkspaceId}`,
            `platform id   ${p.externalUserId}`,
            `first seen    ${when(p.firstSeenAt)}`,
            `last seen     ${when(p.lastSeenAt)}`,
          ].join("\n"),
        );
      });
    });
}

/**
 * Register `event list|view`.
 * @param program - The root program.
 */
export function registerEventCommands(program: Command): void {
  const event = program
    .command("event")
    .description(
      "Platform deliveries the project's bots received, and what became of each (admin): list|view",
    );

  withPaging(
    event
      .command("list")
      .description("List platform deliveries, newest first, with each outcome")
      .option(
        "--status <status>",
        `one of ${TRIGGER_EVENT_STATUSES.join(", ")}`,
      )
      .option(
        "--outcome <outcome>",
        "only this outcome, or those starting with it, e.g. unbound",
      )
      .option("--installation <id>", "only this installation's"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as {
        status?: string;
        outcome?: string;
        installation?: string;
      };
      if (
        o.status !== undefined &&
        !(TRIGGER_EVENT_STATUSES as readonly string[]).includes(o.status)
      ) {
        throw new Error(
          `--status is one of ${TRIGGER_EVENT_STATUSES.join(", ")}; got "${o.status}".`,
        );
      }
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<Paginated<"triggerEvents", TriggerEvent>>(
          "GET",
          `/project/${projectId}/trigger-events`,
          {
            query: {
              ...pageQuery(this),
              status: o.status,
              outcome: o.outcome,
              botInstallationId:
                o.installation !== undefined
                  ? parseNumber(o.installation, "--installation")
                  : undefined,
            },
          },
        );
      emit(
        ctx,
        result,
        () =>
          table(
            result.triggerEvents.map((e) => ({
              id: e.id,
              platform: e.type,
              installation: e.botInstallationId ?? "-",
              status: e.status,
              outcome: e.error
                ? `${e.outcome ?? ""} ${e.error}`.trim()
                : (e.outcome ?? "-"),
              received: when(e.receivedAt),
            })),
            [
              { key: "id" },
              { key: "platform" },
              { key: "installation" },
              { key: "status" },
              { key: "outcome", maxWidth: 60 },
              { key: "received" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  event
    .command("view")
    .description("Show one delivery: its payload as received and its outcome")
    .argument("<event>", "the event's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ triggerEvent: TriggerEvent }>(
            "GET",
            `/project/${projectId}/trigger-event/${idOf(raw, "An event")}`,
          );
        const e = result.triggerEvent;
        emit(ctx, result, () => {
          const lines = [
            `event ${e.id} — ${e.status}${e.outcome ? `: ${e.outcome}` : ""}`,
            `platform      ${e.type}`,
            `installation  ${e.botInstallationId ?? "-"}`,
            `event id      ${e.externalEventId}`,
            `received      ${when(e.receivedAt)}`,
            `processed     ${when(e.processedAt)}`,
            `attempts      ${e.attempts}`,
          ];
          if (e.error) lines.push(`error         ${e.error}`);
          if (e.detail != null) {
            lines.push(`detail        ${JSON.stringify(e.detail)}`);
          }
          lines.push(
            "",
            "payload:",
            JSON.stringify(e.payload ?? null, null, 2),
          );
          return lines.join("\n");
        });
      });
    });
}
