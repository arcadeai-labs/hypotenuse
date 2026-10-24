/**
 * `hypotenuse cost` — what the selected project's agent sessions cost
 * (`cost:list`, `cost:summary`): one record per claim of a turn, with the
 * tokens and US dollars its coding agent reported and whom it is attributed
 * to, and those records totalled by session, issue, runner, person, role,
 * agent, repository, or day.
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

/** A cost record as `cost:list` serializes it. */
export interface CostRecord {
  id: number;
  agentSessionId: number;
  rootAgentSessionId: number;
  workItemId: number;
  kind: string;
  role: string | null;
  repository: string | null;
  issueIdentifier: string | null;
  runnerId: number | null;
  runnerName: string;
  runnerUserId: number | null;
  issuerUserId: number | null;
  agentId: string | null;
  ending: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  claimedAt: number;
  endedAt: number;
}

/** What a set of records adds up to. */
export interface CostTotals {
  turns: number;
  unpricedTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** One group of `cost:summary`. */
export interface CostGroup extends CostTotals {
  key: string | null;
  label: string | null;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/** What `cost summary --by` accepts, as the server does. */
export const COST_DIMENSIONS = [
  "session",
  "root-session",
  "issue",
  "runner",
  "owner",
  "issuer",
  "role",
  "agent",
  "repository",
  "day",
] as const;

/**
 * Dollars as a person reads them: cents, or more places below a cent.
 * @param usd - Dollars, or null when the agent reported none.
 * @returns `$1.25`, `$0.0042`, or `-`.
 */
export function usd(usd: number | null): string {
  if (usd === null) return "-";
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Totals on one line: `$3.50 over 8 turns (2 unpriced), 1,255 in / 310 out`.
 * @param totals - The totals.
 * @returns The line.
 */
export function describeTotals(totals: CostTotals): string {
  const turns = `${totals.turns} turn${totals.turns === 1 ? "" : "s"}`;
  const unpriced = totals.unpricedTurns
    ? ` (${totals.unpricedTurns} unpriced)`
    : "";
  const tokens = `${totals.inputTokens.toLocaleString("en-US")} in / ${totals.outputTokens.toLocaleString("en-US")} out`;
  return `${usd(totals.costUsd)} over ${turns}${unpriced}, ${tokens}`;
}

/**
 * The filter options `cost list` and `cost summary` share.
 * @param command - The command.
 * @returns The command, with the options.
 */
function withFilters(command: Command): Command {
  return command
    .option("--session <id>", "only this agent session's turns")
    .option(
      "--root-session <id>",
      "only this manager session's turns and its dispatched workers'",
    )
    .option("--runner <id>", "only turns this runner ran")
    .option("--owner <userId>", "only turns on runners this user owns")
    .option("--issuer <userId>", "only turns this user asked for")
    .option("--role <role>", "only turns in this role: manager or worker")
    .option(
      "--since <time>",
      "only turns that ended since: ISO-8601, epoch ms, or 7d / 12h / 30m",
    )
    .option(
      "--until <time>",
      "only turns that ended before: ISO-8601, epoch ms, or 7d / 12h / 30m",
    );
}

/**
 * The query the filter options make.
 * @param command - The command, parsed.
 * @returns Query parameters.
 */
function filterQuery(command: Command): Record<string, string | undefined> {
  const opts = command.opts() as Record<string, string | undefined>;
  return {
    agentSessionId: opts.session,
    rootAgentSessionId: opts.rootSession,
    runnerId: opts.runner,
    runnerUserId: opts.owner,
    issuerUserId: opts.issuer,
    role: opts.role,
    since: opts.since ? String(parseTime(opts.since)) : undefined,
    until: opts.until ? String(parseTime(opts.until)) : undefined,
  };
}

/**
 * Register `cost list` and `cost summary`.
 * @param program - The root program.
 */
export function registerCostCommands(program: Command): void {
  const cost = program
    .command("cost")
    .description(
      "What the selected project's agent sessions cost, and whom it is attributed to",
    );

  withPaging(
    withFilters(
      cost
        .command("list")
        .description(
          "List each turn's cost, newest first, with its session, runner, and role",
        ),
    ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        costRecords: CostRecord[];
        total: CostTotals;
        pagination: Pagination;
      }>("GET", "/costs", {
        query: { projectId, ...filterQuery(this), ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          `${table(
            result.costRecords.map((r) => ({
              ended: when(r.endedAt),
              issue: r.issueIdentifier ?? "-",
              session: r.agentSessionId,
              role: r.role ?? "-",
              kind: r.kind,
              runner: r.runnerName,
              agent: r.agentId ?? "-",
              ending: r.ending,
              tokens: `${r.inputTokens ?? "-"} / ${r.outputTokens ?? "-"}`,
              cost: usd(r.costUsd),
            })),
            [
              { key: "ended" },
              { key: "issue" },
              { key: "session" },
              { key: "role" },
              { key: "kind" },
              { key: "runner" },
              { key: "agent" },
              { key: "ending" },
              { key: "tokens" },
              { key: "cost" },
            ],
          )}\ntotal ${describeTotals(result.total)}${pageFooter(result.pagination)}`,
      );
    });
  });

  withPaging(
    withFilters(
      cost
        .command("summary")
        .description(
          "Total the turns' cost by one dimension, most expensive first",
        )
        .option(
          "--by <dimension>",
          `what to group by: ${COST_DIMENSIONS.join(", ")}`,
          "session",
        ),
    ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const { by } = this.opts() as { by: string };
      const result = await ctx.signedInClient().request<{
        by: string;
        groups: CostGroup[];
        total: CostTotals;
        pagination: Pagination;
      }>("GET", "/costs/summary", {
        query: { projectId, by, ...filterQuery(this), ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          `${table(
            result.groups.map((g) => ({
              [result.by]: g.label ?? g.key ?? "(none)",
              turns: g.turns,
              unpriced: g.unpricedTurns,
              "input tokens": g.inputTokens,
              "output tokens": g.outputTokens,
              cost: usd(g.costUsd),
            })),
            [
              { key: result.by, maxWidth: 50 },
              { key: "turns" },
              { key: "unpriced" },
              { key: "input tokens" },
              { key: "output tokens" },
              { key: "cost" },
            ],
          )}\ntotal ${describeTotals(result.total)}${pageFooter(result.pagination)}`,
      );
    });
  });
}
