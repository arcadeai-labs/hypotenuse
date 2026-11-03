import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { type Bot, bots } from "../schema/bots";
import { channels } from "../schema/channels";
import { conversations } from "../schema/conversations";
import { costRecords } from "../schema/cost_records";
import type { Tag } from "../schema/tags";
import { canDecide } from "./ApprovalOps";
import { avatarPath, canWriteBot } from "./BotOps";
import { conversationUrl } from "./ConversationLinkOps";
import { serializeConversation } from "./ConversationOps";
import type { DbHandle } from "./DbOps";
import { canAnswerHelp } from "./HelpOps";

/** The kinds a `waiting` conversation waits on, in the order the home shows them. */
export const WAITING_KINDS = [
  "answer",
  "approval",
  "help",
  "sandbox",
  "timer",
] as const;

/** One of {@link WAITING_KINDS}. */
export type WaitingKind = (typeof WAITING_KINDS)[number];

/** Live counts for one bot, by conversation state. */
export interface BotCounts {
  working: number;
  hibernating: number;
  waiting: Record<WaitingKind, number>;
  waitingTotal: number;
  /** Conversations that ended since the start of today (UTC). */
  endedToday: number;
}

/**
 * Zeroed counts.
 * @returns Counts with every number 0.
 */
export function emptyCounts(): BotCounts {
  return {
    working: 0,
    hibernating: 0,
    waiting: { answer: 0, approval: 0, help: 0, sandbox: 0, timer: 0 },
    waitingTotal: 0,
    endedToday: 0,
  };
}

/**
 * The start of today in UTC — the boundary "today" means on the home page,
 * the same for every reader whatever their time zone.
 * @param now - The current time.
 * @returns Midnight UTC.
 */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Count the conversations of the given bots by state and waiting kind, and
 * those that ended today. One grouped query.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read.
 * @param since - The start of today.
 * @returns Counts per bot id (every given bot present).
 */
export async function countConversations(
  db: DbHandle,
  projectId: number,
  botIds: number[],
  since: Date,
): Promise<Map<number, BotCounts>> {
  const out = new Map<number, BotCounts>(
    botIds.map((id) => [id, emptyCounts()]),
  );
  if (botIds.length === 0) return out;
  const rows = await db
    .select({
      botId: conversations.botId,
      state: conversations.state,
      kind: sql<string | null>`${conversations.waitingOn}->>'kind'`,
      n: sql<number>`count(*)::int`,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, projectId),
        inArray(conversations.botId, botIds),
        sql`(${conversations.state} <> 'ended' or ${conversations.updatedAt} >= ${since.toISOString()})`,
      ),
    )
    .groupBy(
      conversations.botId,
      conversations.state,
      sql`${conversations.waitingOn}->>'kind'`,
    );
  for (const row of rows) {
    const c = out.get(row.botId);
    if (!c) continue;
    if (row.state === "working") c.working += row.n;
    else if (row.state === "hibernating") c.hibernating += row.n;
    else if (row.state === "ended") c.endedToday += row.n;
    else if (row.state === "waiting") {
      c.waitingTotal += row.n;
      const kind = row.kind as WaitingKind | null;
      if (kind && kind in c.waiting) c.waiting[kind] += row.n;
    }
  }
  return out;
}

/**
 * Model spend recorded today, per bot: the sum of priced cost records and
 * the count of unpriced ones (a model without a price is not free — it is
 * unknown, and the page says so).
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read.
 * @param since - The start of today.
 * @returns Spend per bot id.
 */
export async function spendToday(
  db: DbHandle,
  projectId: number,
  botIds: number[],
  since: Date,
): Promise<Map<number, { usd: number; unpriced: number }>> {
  const out = new Map<number, { usd: number; unpriced: number }>();
  if (botIds.length === 0) return out;
  const rows = await db
    .select({
      botId: costRecords.botId,
      usd: sql<string | null>`sum(${costRecords.costUsd})`,
      unpriced: sql<number>`count(*) filter (where ${costRecords.costUsd} is null)::int`,
    })
    .from(costRecords)
    .where(
      and(
        eq(costRecords.projectId, projectId),
        inArray(costRecords.botId, botIds),
        gte(costRecords.createdAt, since),
      ),
    )
    .groupBy(costRecords.botId);
  for (const row of rows) {
    out.set(row.botId, {
      usd: row.usd === null ? 0 : Number(row.usd),
      unpriced: row.unpriced,
    });
  }
  return out;
}

/**
 * The most recently changed conversations of the given bots, each with its
 * bot, channel, and platform link: the home page's feed.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read.
 * @param limit - How many.
 * @returns The conversations, newest change first.
 */
export async function recentConversations(
  db: DbHandle,
  projectId: number,
  botIds: number[],
  limit: number,
) {
  if (botIds.length === 0) return [];
  const rows = await db
    .select({ conversation: conversations, bot: bots, channel: channels })
    .from(conversations)
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(
      and(
        eq(conversations.projectId, projectId),
        inArray(conversations.botId, botIds),
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
  return Promise.all(
    rows.map(async (r) => ({
      ...serializeConversation(r.conversation),
      bot: { id: r.bot.id, name: r.bot.name, slug: r.bot.slug },
      channel: { id: r.channel.id, name: r.channel.name, type: r.channel.type },
      platformUrl: await conversationUrl(db, r.conversation, r.channel),
    })),
  );
}

/**
 * The bot as the home page shows it.
 * @param bot - The row.
 * @param callerTags - The caller's tags.
 * @returns Its identity, and what the caller may do with it.
 */
export function serializeOverviewBot(bot: Bot, callerTags: Tag[]) {
  return {
    id: bot.id,
    name: bot.name,
    displayName: bot.displayName,
    slug: bot.slug,
    avatarPath: avatarPath(bot),
    canWrite: canWriteBot(bot, callerTags),
  };
}

/** Every kind of thing the inbox holds. */
export const INBOX_KINDS = ["approval", "help", "sandbox-question"] as const;

/** One of {@link INBOX_KINDS}. */
export type InboxKind = (typeof INBOX_KINDS)[number];

/** One inbox row, as the union query returns it. */
interface InboxRow {
  kind: InboxKind;
  id: number;
  bot_id: number;
  conversation_id: number | null;
  job_id: number | null;
  title: string;
  detail: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  [key: string]: unknown;
}

/**
 * The pending things a person can answer — approvals, help requests, and
 * sandbox questions to the conversation — as one SQL union, so pagination
 * and the total are over the whole set. A sandbox question to the team is
 * already a help request and is not listed twice.
 * @param kinds - Which kinds to include.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read (never empty here).
 * @returns The union's SQL, without order or limit.
 */
function inboxUnion(kinds: InboxKind[], projectId: number, botIds: number[]) {
  const ids = sql.join(
    botIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const parts = [];
  if (kinds.includes("approval")) {
    parts.push(sql`select 'approval' as kind, a.id, a.bot_id, a.conversation_id, null::int as job_id,
      (a.server || '/' || a.tool) as title, a.reason as detail, a.created_at, a.expires_at
      from approvals a where a.project_id = ${projectId} and a.status = 'pending' and a.bot_id in (${ids})`);
  }
  if (kinds.includes("help")) {
    parts.push(sql`select 'help' as kind, h.id, h.bot_id, h.conversation_id, null::int as job_id,
      h.question as title, (case when h.urgency = 'normal' then null else h.urgency || ' urgency' end) as detail, h.created_at, h.expires_at
      from help_requests h where h.project_id = ${projectId} and h.status = 'pending' and h.bot_id in (${ids})`);
  }
  if (kinds.includes("sandbox-question")) {
    parts.push(sql`select 'sandbox-question' as kind, q.id, j.bot_id, j.parent_conversation_id as conversation_id, j.id as job_id,
      q.question as title, j.title as detail, q.created_at, q.expires_at
      from sandbox_job_questions q join sandbox_jobs j on j.id = q.job_id
      where j.project_id = ${projectId} and q.kind = 'conversation' and q.status = 'pending' and j.bot_id in (${ids})`);
  }
  return sql.join(parts, sql` union all `);
}

/**
 * Read a page of the inbox.
 * @param db - A database handle.
 * @param input - The project, the readable bots, the kinds, and the page.
 * @returns The rows (newest first) and the total.
 */
export async function readInbox(
  db: DbHandle,
  input: {
    projectId: number;
    botIds: number[];
    kinds: InboxKind[];
    botId?: number;
    limit: number;
    offset: number;
  },
): Promise<{ rows: InboxRow[]; total: number }> {
  const botIds = input.botId
    ? input.botIds.filter((id) => id === input.botId)
    : input.botIds;
  if (botIds.length === 0 || input.kinds.length === 0) {
    return { rows: [], total: 0 };
  }
  const union = inboxUnion(input.kinds, input.projectId, botIds);
  const result = await db.execute<InboxRow>(
    sql`select * from (${union}) inbox order by created_at desc, kind, id desc limit ${input.limit} offset ${input.offset}`,
  );
  const counted = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from (${union}) inbox`,
  );
  return { rows: result.rows, total: Number(counted.rows[0]?.n ?? 0) };
}

/**
 * Count the pending inbox by kind, for the home page.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read.
 * @returns Counts per kind, and per bot.
 */
export async function countInbox(
  db: DbHandle,
  projectId: number,
  botIds: number[],
): Promise<{
  byKind: Record<InboxKind, number>;
  byBot: Map<number, number>;
}> {
  const byKind: Record<InboxKind, number> = {
    approval: 0,
    help: 0,
    "sandbox-question": 0,
  };
  const byBot = new Map<number, number>();
  if (botIds.length === 0) return { byKind, byBot };
  const union = inboxUnion([...INBOX_KINDS], projectId, botIds);
  const result = await db.execute<{
    kind: InboxKind;
    bot_id: number;
    n: number;
  }>(
    sql`select kind, bot_id, count(*)::int as n from (${union}) inbox group by kind, bot_id`,
  );
  for (const row of result.rows) {
    byKind[row.kind] += Number(row.n);
    byBot.set(row.bot_id, (byBot.get(row.bot_id) ?? 0) + Number(row.n));
  }
  return { byKind, byBot };
}

/**
 * Whether the caller may answer one inbox item: the rule its own action
 * applies (`approval:decide`'s `canDecide`, `help:answer`'s `canAnswerHelp`,
 * `sandbox-job:answer`'s `canWriteBot`).
 * @param kind - The item's kind.
 * @param bot - Its bot.
 * @param callerTags - The caller's tags.
 * @returns `true` if they may answer it here.
 */
export function canAnswerInbox(
  kind: InboxKind,
  bot: Bot,
  callerTags: Tag[],
): boolean {
  if (kind === "approval") return canDecide(bot, callerTags);
  if (kind === "help") return canAnswerHelp(bot, callerTags);
  return canWriteBot(bot, callerTags);
}

/**
 * Shape an inbox row for the API. Timestamps are epoch ms.
 * @param row - The union's row.
 * @param bot - Its bot.
 * @param callerTags - The caller's tags.
 * @returns The item.
 */
export function serializeInboxItem(row: InboxRow, bot: Bot, callerTags: Tag[]) {
  return {
    kind: row.kind,
    id: Number(row.id),
    bot: { id: bot.id, name: bot.name, displayName: bot.displayName },
    conversationId:
      row.conversation_id === null ? null : Number(row.conversation_id),
    jobId: row.job_id === null ? null : Number(row.job_id),
    title: row.title,
    detail: row.detail,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt:
      row.expires_at === null ? null : new Date(row.expires_at).getTime(),
    canAnswer: canAnswerInbox(row.kind, bot, callerTags),
  };
}

/**
 * How much a bot remembers where it works: the current, unforgotten channel
 * memory documents in the channels it has conversations in. Channel memory
 * is shared by every bot in a channel, so two bots in one channel count the
 * same documents; project memory is everyone's and is not counted per bot.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botIds - The bots the caller may read.
 * @returns Document counts per bot id.
 */
export async function memorySizes(
  db: DbHandle,
  projectId: number,
  botIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (botIds.length === 0) return out;
  const ids = sql.join(
    botIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<{ bot_id: number; n: number }>(sql`
    select c.bot_id, count(distinct d.id)::int as n
    from (select distinct bot_id, channel_id from conversations
          where project_id = ${projectId} and bot_id in (${ids})) c
    join memory_documents d
      on d.channel_id = c.channel_id and d.scope = 'channel'
     and d.is_current and not d.tombstone
    group by c.bot_id`);
  for (const row of result.rows) out.set(Number(row.bot_id), Number(row.n));
  return out;
}
