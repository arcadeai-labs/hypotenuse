import type { TurnUsage } from "@hypotenuse/protocol";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { api } from "keryx";
import { z } from "zod";
import {
  AGENT_SESSION_ROLES,
  type AgentSessionRole,
  agentSessions,
} from "../schema/agent_sessions";
import {
  type CostRecord,
  type CostRecordEnding,
  costRecords,
} from "../schema/cost_records";
import { runners } from "../schema/runners";
import { users } from "../schema/users";
import type { WorkItem, WorkItemUsage } from "../schema/work_items";
import type { TxHandle } from "./ProjectOps";

/**
 * Cost attribution: one {@link costRecords} row per claim of a turn that
 * ended, and the totals read from them. The records are the daemon half's
 * bookkeeping, written beside the work item they describe and never audited.
 */

/**
 * Record what a claim of a turn spent and whom it is attributable to, as the
 * claim ends — finished, or back in the queue. An item that was never claimed
 * spent nothing and is skipped; recording the same claim twice is harmless.
 * @param tx - The transaction ending the claim.
 * @param item - The item as the claim left it (its runner, claim time, and usage).
 * @param ending - How the claim ended.
 */
export async function recordClaimCost(
  tx: TxHandle,
  item: WorkItem,
  ending: CostRecordEnding,
): Promise<void> {
  if (item.runnerId === null || item.claimedAt === null) return;
  const [session] = await tx
    .select({
      externalIssueId: agentSessions.externalIssueId,
      issueIdentifier: agentSessions.issueIdentifier,
      parentAgentSessionId: agentSessions.parentAgentSessionId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, item.agentSessionId));
  const [runner] = await tx
    .select({ name: runners.name, userId: runners.userId })
    .from(runners)
    .where(eq(runners.id, item.runnerId));
  const usage = item.usage ?? {};
  await tx
    .insert(costRecords)
    .values({
      projectId: item.projectId,
      agentSessionId: item.agentSessionId,
      rootAgentSessionId: session?.parentAgentSessionId ?? item.agentSessionId,
      workItemId: item.id,
      kind: item.kind,
      role: item.role,
      repository: item.repository,
      externalIssueId: session?.externalIssueId ?? null,
      issueIdentifier: session?.issueIdentifier ?? null,
      runnerId: item.runnerId,
      runnerName: runner?.name ?? `runner ${item.runnerId}`,
      runnerUserId: runner?.userId ?? null,
      issuerUserId: item.preferredUserId,
      agentId: item.agentId,
      ending,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      costUsd: usage.costUsd ?? null,
      claimedAt: item.claimedAt,
    })
    .onConflictDoNothing();
}

/**
 * Fill in what a claim spent from a completion that arrived after the server
 * had already ended it (a stop past its grace period). Only figures the
 * record does not have are written: the claim's own events came first.
 * @param tx - The transaction.
 * @param item - The terminal item, still naming the claim's runner.
 * @param usage - The completion's usage.
 */
export async function fillLateClaimCost(
  tx: TxHandle,
  item: WorkItem,
  usage: TurnUsage,
): Promise<void> {
  if (item.claimedAt === null) return;
  await tx
    .update(costRecords)
    .set({
      inputTokens: sql`coalesce(${costRecords.inputTokens}, ${usage.inputTokens ?? null}::integer)`,
      outputTokens: sql`coalesce(${costRecords.outputTokens}, ${usage.outputTokens ?? null}::integer)`,
      costUsd: sql`coalesce(${costRecords.costUsd}, ${usage.costUsd ?? null}::numeric)`,
    })
    .where(
      and(
        eq(costRecords.workItemId, item.id),
        eq(costRecords.claimedAt, item.claimedAt),
      ),
    );
}

/**
 * Lay a completion's usage over what the turn's events reported: the
 * completion is the daemon's final word.
 * @param reported - The item's usage so far.
 * @param final - The completion's usage, if it carried one.
 * @returns The merged usage, or the reported one unchanged.
 */
export function mergeUsage(
  reported: WorkItemUsage | null,
  final: TurnUsage | undefined,
): WorkItemUsage | null {
  if (!final) return reported;
  return { ...(reported ?? {}), ...final };
}

/**
 * Shape a cost record for the API, timestamps as epoch ms.
 * @param row - The row.
 * @returns The serialized record.
 */
export function serializeCostRecord(row: CostRecord) {
  return {
    id: row.id,
    projectId: row.projectId,
    agentSessionId: row.agentSessionId,
    rootAgentSessionId: row.rootAgentSessionId,
    workItemId: row.workItemId,
    kind: row.kind,
    role: row.role,
    repository: row.repository,
    externalIssueId: row.externalIssueId,
    issueIdentifier: row.issueIdentifier,
    runnerId: row.runnerId,
    runnerName: row.runnerName,
    runnerUserId: row.runnerUserId,
    issuerUserId: row.issuerUserId,
    agentId: row.agentId,
    ending: row.ending,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    claimedAt: row.claimedAt.getTime(),
    endedAt: row.endedAt.getTime(),
  };
}

/** {@link serializeCostRecord}'s output. */
export type SerializedCostRecord = ReturnType<typeof serializeCostRecord>;

/** What a set of records adds up to. */
export interface CostTotals {
  /** Claims recorded. */
  turns: number;
  /** Claims whose agent reported no cost. */
  unpricedTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** US dollars; null when no claim reported a cost. */
  costUsd: number | null;
}

/** The aggregate columns every total and group shares. */
const totalColumns = {
  turns: sql<number>`count(*)::int`,
  unpricedTurns: sql<number>`(count(*) - count(${costRecords.costUsd}))::int`,
  inputTokens: sql<number>`coalesce(sum(${costRecords.inputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${costRecords.outputTokens}), 0)::bigint`,
  costUsd: sql<number | null>`sum(${costRecords.costUsd})::float8`,
};

/**
 * Normalize a totals row from SQL (bigints arrive as strings).
 * @param row - The aggregate row.
 * @returns The totals.
 */
function toTotals(row: CostTotals | undefined): CostTotals {
  return {
    turns: Number(row?.turns ?? 0),
    unpricedTurns: Number(row?.unpricedTurns ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    costUsd:
      row?.costUsd === null || row?.costUsd === undefined
        ? null
        : roundUsd(Number(row.costUsd)),
  };
}

/**
 * Round to the precision the records keep, so a sum's float noise is not shown.
 * @param usd - Dollars.
 * @returns Dollars, to the millionth.
 */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Total the records matching a condition.
 * @param where - The condition.
 * @returns The totals.
 */
export async function costTotals(where: SQL | undefined): Promise<CostTotals> {
  const [row] = await api.db.db
    .select(totalColumns)
    .from(costRecords)
    .where(where);
  return toTotals(row);
}

/**
 * What a session cost, and for a manager what it and every worker it
 * dispatched cost together (`tree`); `tree` is null for a session that was
 * itself dispatched, whose manager's tree includes it.
 * @param session - The session's id and parent.
 * @returns Its totals, and its tree's.
 */
export async function sessionCosts(session: {
  id: number;
  parentAgentSessionId: number | null;
}): Promise<{ cost: CostTotals; treeCost: CostTotals | null }> {
  const [cost, treeCost] = await Promise.all([
    costTotals(eq(costRecords.agentSessionId, session.id)),
    session.parentAgentSessionId === null
      ? costTotals(eq(costRecords.rootAgentSessionId, session.id))
      : Promise.resolve(null),
  ]);
  return { cost, treeCost };
}

/** What `cost:summary` can group by. */
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

/** One of {@link COST_DIMENSIONS}. */
export type CostDimension = (typeof COST_DIMENSIONS)[number];

/** The filters `cost:list` and `cost:summary` share. */
export interface CostFilters {
  agentSessionId?: number;
  rootAgentSessionId?: number;
  runnerId?: number;
  runnerUserId?: number;
  issuerUserId?: number;
  role?: AgentSessionRole;
  since?: Date;
  until?: Date;
}

/** A time as ISO-8601 or epoch ms (an all-digits string is epoch ms, which `new Date` misreads). */
const timeInput = z.preprocess(
  (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
  z.coerce.date(),
);

/** An optional positive id from a query string. */
const idInput = z.coerce.number().int().positive().optional();

/** The inputs `cost:list` and `cost:summary` share: the project and {@link CostFilters}. */
export const costFilterInputs = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .describe("The project whose costs to read"),
  agentSessionId: idInput.describe("Only this agent session's turns"),
  rootAgentSessionId: idInput.describe(
    "Only this manager session's turns and those of the workers it dispatched",
  ),
  runnerId: idInput.describe("Only turns this runner ran"),
  runnerUserId: idInput.describe(
    "Only turns run on runners this Hypotenuse user owns",
  ),
  issuerUserId: idInput.describe("Only turns this Hypotenuse user asked for"),
  role: z
    .enum(AGENT_SESSION_ROLES)
    .optional()
    .describe("Only turns in this role"),
  since: timeInput
    .optional()
    .describe(
      "Only turns that ended at or after this time, as ISO-8601 or epoch milliseconds",
    ),
  until: timeInput
    .optional()
    .describe(
      "Only turns that ended before this time, as ISO-8601 or epoch milliseconds",
    ),
});

/**
 * The condition for a project's records under some filters.
 * @param projectId - The project.
 * @param filters - The filters.
 * @returns The condition.
 */
export function costWhere(projectId: number, filters: CostFilters): SQL {
  return and(
    eq(costRecords.projectId, projectId),
    filters.agentSessionId !== undefined
      ? eq(costRecords.agentSessionId, filters.agentSessionId)
      : undefined,
    filters.rootAgentSessionId !== undefined
      ? eq(costRecords.rootAgentSessionId, filters.rootAgentSessionId)
      : undefined,
    filters.runnerId !== undefined
      ? eq(costRecords.runnerId, filters.runnerId)
      : undefined,
    filters.runnerUserId !== undefined
      ? eq(costRecords.runnerUserId, filters.runnerUserId)
      : undefined,
    filters.issuerUserId !== undefined
      ? eq(costRecords.issuerUserId, filters.issuerUserId)
      : undefined,
    filters.role !== undefined ? eq(costRecords.role, filters.role) : undefined,
    filters.since ? gte(costRecords.endedAt, filters.since) : undefined,
    filters.until ? lt(costRecords.endedAt, filters.until) : undefined,
  ) as SQL;
}

const groupUser = alias(users, "cost_group_user");
const groupRoot = alias(agentSessions, "cost_group_root");

/**
 * How a dimension groups: its key, what a person reads for it, and the table
 * that names it, if any.
 * @param by - The dimension.
 * @returns The key and label expressions, and the join.
 */
function dimension(by: CostDimension): {
  key: SQL<string | null>;
  label: SQL<string | null>;
  join?: { table: typeof groupUser | typeof groupRoot; on: SQL };
} {
  switch (by) {
    case "session":
      return {
        key: sql`${costRecords.agentSessionId}::text`,
        label: sql`max(${costRecords.issueIdentifier})`,
      };
    case "root-session":
      return {
        key: sql`${costRecords.rootAgentSessionId}::text`,
        label: sql`max(${groupRoot.issueIdentifier})`,
        join: {
          table: groupRoot,
          on: eq(groupRoot.id, costRecords.rootAgentSessionId),
        },
      };
    case "issue":
      return {
        key: sql`${costRecords.externalIssueId}`,
        label: sql`max(${costRecords.issueIdentifier})`,
      };
    case "runner":
      return {
        key: sql`${costRecords.runnerId}::text`,
        label: sql`max(${costRecords.runnerName})`,
      };
    case "owner":
      return {
        key: sql`${costRecords.runnerUserId}::text`,
        label: sql`max(${groupUser.name})`,
        join: {
          table: groupUser,
          on: eq(groupUser.id, costRecords.runnerUserId),
        },
      };
    case "issuer":
      return {
        key: sql`${costRecords.issuerUserId}::text`,
        label: sql`max(${groupUser.name})`,
        join: {
          table: groupUser,
          on: eq(groupUser.id, costRecords.issuerUserId),
        },
      };
    case "role":
      return {
        key: sql`${costRecords.role}`,
        label: sql`max(${costRecords.role})`,
      };
    case "agent":
      return {
        key: sql`${costRecords.agentId}`,
        label: sql`max(${costRecords.agentId})`,
      };
    case "repository":
      return {
        key: sql`${costRecords.repository}`,
        label: sql`max(${costRecords.repository})`,
      };
    case "day":
      return {
        key: sql`to_char(${costRecords.endedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        label: sql`max(to_char(${costRecords.endedAt} at time zone 'UTC', 'YYYY-MM-DD'))`,
      };
  }
}

/** One group of a summary. */
export interface CostGroup extends CostTotals {
  /** The dimension's value (an id as text, a role, a day); null for records without one. */
  key: string | null;
  /** What a person reads for it: an issue identifier, a runner or person's name. */
  label: string | null;
}

/**
 * A page of a project's records totalled by a dimension, most expensive
 * first, and the total over every group.
 * @param projectId - The project.
 * @param by - The dimension.
 * @param filters - The filters.
 * @param page - Which page.
 * @returns The page's groups, how many groups there are, and the total.
 */
export async function costSummary(
  projectId: number,
  by: CostDimension,
  filters: CostFilters,
  page: { page: number; limit: number },
): Promise<{ groups: CostGroup[]; groupCount: number; total: CostTotals }> {
  const where = costWhere(projectId, filters);
  const { key, label, join } = dimension(by);
  const base = api.db.db
    .select({ key: sql<string | null>`${key}`, label, ...totalColumns })
    .from(costRecords);
  const joined = join ? base.leftJoin(join.table, join.on) : base;
  const grouped = joined
    .where(where)
    .groupBy(key)
    .orderBy(
      sql`sum(${costRecords.costUsd}) desc nulls last`,
      sql`count(*) desc`,
      sql`${key} asc nulls last`,
    );
  const [rows, [counted], total] = await Promise.all([
    grouped.limit(page.limit).offset((page.page - 1) * page.limit),
    api.db.db
      // A null key (a deleted runner, no repository) is a group of its own.
      .select({
        count: sql<number>`(count(distinct ${key}) + coalesce(bool_or(${key} is null)::int, 0))::int`,
      })
      .from(costRecords)
      .where(where),
    costTotals(where),
  ]);
  return {
    groups: rows.map((row) => ({
      key: row.key,
      label: row.label,
      ...toTotals(row),
    })),
    groupCount: Number(counted?.count ?? 0),
    total,
  };
}
