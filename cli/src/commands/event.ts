/**
 * `hypotenuse event` — the selected project's event log (`trigger-event:list`,
 * `trigger-event:view`): every webhook its Linear workspace sent, what each
 * did, and how the work was routed — the role and the rule that chose it,
 * and where the turn is now.
 */
import type { Command } from "commander";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";
import { parseTime } from "./audit";

/** An event as `trigger-event:list` and `trigger-event:view` serialize it. */
export interface TriggerEvent {
  id: number;
  type: string;
  deliveryId: string;
  eventType: string;
  action: string;
  outcome: string;
  summary: string | null;
  error: string | null;
  issueIdentifier: string | null;
  receivedAt: number;
  processedAt: number | null;
  session: {
    id: number;
    issueTitle: string | null;
    status: string;
    role: "manager" | "worker" | null;
    routingRule: { id: number | null; name: string } | null;
    dispatched: boolean;
  } | null;
  turn: {
    id: number;
    kind: string;
    status: string;
    repository: string | null;
    runner: { id: number; name: string } | null;
    waitingReason: string | null;
    waitingCode: string | null;
    cancelReason: string | null;
    finishedAt: number | null;
  } | null;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/**
 * How an event's session got its role: `worker (default)`,
 * `manager (rule /manage)`, `worker (dispatched)`, or `-`.
 * @param event - The event.
 * @returns The words.
 */
export function routedAs(event: TriggerEvent): string {
  const s = event.session;
  if (!s?.role) return "-";
  const why = s.routingRule
    ? `rule ${s.routingRule.name}`
    : s.dispatched
      ? "dispatched"
      : "default";
  return `${s.role} (${why})`;
}

/**
 * Where an event's turn is now: its status and runner, or why it waits.
 * @param event - The event.
 * @returns The words, or `-` when it touched no turn.
 */
export function turnPlace(event: TriggerEvent): string {
  const t = event.turn;
  if (!t) return "-";
  if (t.status === "queued") {
    return `queued: ${t.waitingCode ?? t.waitingReason ?? "waiting"}`;
  }
  if (t.status === "cancelled") {
    return `cancelled${t.cancelReason ? `: ${t.cancelReason}` : ""}`;
  }
  return t.runner ? `${t.status} on ${t.runner.name}` : t.status;
}

/**
 * The human rendering of one event and, for an admin, its payload.
 * @param event - The event.
 * @param payload - The body Linear sent, or null when not an admin.
 * @returns Lines for stdout.
 */
export function describeEvent(
  event: TriggerEvent,
  payload: Record<string, unknown> | null,
): string {
  const lines = [
    `${event.eventType} ${event.action}${event.issueIdentifier ? `  ${event.issueIdentifier}` : ""}`,
    `outcome    ${event.outcome}`,
    `summary    ${event.summary ?? "-"}`,
    `received   ${when(event.receivedAt)}`,
    `processed  ${when(event.processedAt)}`,
    `delivery   ${event.deliveryId}`,
  ];
  if (event.error) lines.push(`error      ${event.error}`);
  if (event.session) {
    lines.push(`session    ${event.session.id} (${event.session.status})`);
    lines.push(`routed as  ${routedAs(event)}`);
  }
  if (event.turn) {
    lines.push(
      `turn       ${event.turn.id} ${event.turn.kind}, ${turnPlace(event)}`,
    );
    if (event.turn.waitingReason && event.turn.status === "queued") {
      lines.push(`waiting    ${event.turn.waitingReason}`);
    }
  }
  lines.push(
    "",
    payload
      ? JSON.stringify(payload, null, 2)
      : "payload    (project admins only)",
  );
  return lines.join("\n");
}

/**
 * Register `event list` and `event view`.
 * @param program - The root program.
 */
export function registerEventCommands(program: Command): void {
  const event = program
    .command("event")
    .description(
      "The selected project's event log: Linear's webhooks and how each was routed",
    );

  withPaging(
    event
      .command("list")
      .description("List webhook events, newest first")
      .option(
        "--type <eventType>",
        "only this event type, e.g. AgentSessionEvent, Issue, PermissionChange",
      )
      .option(
        "--outcome <outcome>",
        "only this outcome: handled, ignored, duplicate_of_dispatch, failed, pending",
      )
      .option("--hide-ignored", "leave out events Hypotenuse did not act on")
      .option("--session <id>", "only events about this agent session")
      .option(
        "--since <time>",
        "only events since: ISO-8601, epoch ms, or 7d / 12h / 30m",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as {
        type?: string;
        outcome?: string;
        hideIgnored?: boolean;
        session?: string;
        since?: string;
      };
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        triggerEvents: TriggerEvent[];
        pagination: Pagination;
      }>("GET", "/trigger-events", {
        query: {
          projectId,
          eventType: opts.type,
          outcome: opts.outcome,
          hideIgnored: opts.hideIgnored ? true : undefined,
          agentSessionId: opts.session,
          since: opts.since ? parseTime(opts.since) : undefined,
          ...pageQuery(this),
        },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.triggerEvents.map((e) => ({
              id: e.id,
              received: when(e.receivedAt),
              event: `${e.eventType} ${e.action}`,
              issue: e.issueIdentifier ?? "-",
              outcome: e.outcome,
              "routed as": routedAs(e),
              turn: turnPlace(e),
              summary: e.summary ?? "",
            })),
            [
              { key: "id" },
              { key: "received" },
              { key: "event" },
              { key: "issue" },
              { key: "outcome" },
              { key: "routed as" },
              { key: "turn", maxWidth: 40 },
              { key: "summary", maxWidth: 70 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  event
    .command("view <id>")
    .description(
      "Show one event: what it did, how it was routed, and (admins) its payload",
    )
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          triggerEvent: TriggerEvent;
          payload: Record<string, unknown> | null;
        }>("GET", `/trigger-event/${id}`, { query: { projectId } });
        emit(ctx, result, () =>
          describeEvent(result.triggerEvent, result.payload),
        );
      });
    });
}
