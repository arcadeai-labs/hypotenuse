import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { conversationInbox } from "../schema/conversation_inbox";
import { costRecords } from "../schema/cost_records";
import { scheduleRuns } from "../schema/schedule_runs";
import type { DbHandle } from "./DbOps";

/**
 * How a scheduled turn's run is settled. A run is `woken` once its inbox row
 * is written; **the turn that delivers that row settles it** when the turn
 * ends, in the transaction that ends it — so a run's outcome and the turn's
 * are one commit.
 *
 * | The turn that read the schedule's message ended with | The run |
 * |---|---|
 * | `complete` with `silent: true` | `silent` |
 * | `complete`, `reply_and_wait`, or a question (`ask_question`) | `posted` |
 * | `fail`, or the turn failed | `failed`, with the reason |
 * | a wait on a timer, an approval, help, or a sandbox | still `woken`: the turn has not ended |
 * | the conversation was cancelled | `failed`, "cancelled" (even if the message was never read) |
 *
 * This module reads only tables, so the tick and the conversation state
 * machine can call it without importing the schedule clock.
 */

/**
 * The prefix of a scheduled conversation's key before its platform thread
 * exists. The first final message posted opens the thread, and its id
 * replaces the key (`OutboxOps`).
 */
export const PENDING_THREAD_PREFIX = "schedule:";

/**
 * Whether a conversation key is a scheduled conversation's placeholder, not
 * yet a platform thread.
 * @param key - The key.
 * @returns `true` for a placeholder.
 */
export function isPendingThreadKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(PENDING_THREAD_PREFIX);
}

/** How a scheduled turn ended. */
export type ScheduledTurnEnding = "silent" | "posted" | "failed" | "cancelled";

/**
 * Settle every `woken` run of a conversation whose message the transcript
 * has taken in: the turn that read it just ended.
 * @param tx - The transaction that ends the turn.
 * @param conversationId - The conversation.
 * @param ending - How the turn ended.
 * @param reason - Why, for `failed`.
 * @returns How many runs were settled.
 */
export async function settleScheduledTurn(
  tx: DbHandle,
  conversationId: number,
  ending: ScheduledTurnEnding,
  reason?: string,
): Promise<number> {
  const delivered =
    ending === "cancelled"
      ? undefined
      : sql`exists (
          select 1 from ${conversationInbox}
          where ${conversationInbox.id} = ${scheduleRuns.inboxId}
            and ${conversationInbox.deliveredAt} is not null
        )`;
  const runs = await tx
    .select({ id: scheduleRuns.id, startedAt: scheduleRuns.startedAt })
    .from(scheduleRuns)
    .where(
      and(
        eq(scheduleRuns.conversationId, conversationId),
        eq(scheduleRuns.status, "woken"),
        delivered,
      ),
    );
  if (runs.length === 0) return 0;
  const status = ending === "cancelled" ? "failed" : ending;
  const why =
    ending === "cancelled"
      ? "The conversation was cancelled before the bot finished the scheduled turn."
      : ending === "failed"
        ? (reason ?? "The scheduled turn failed.")
        : null;
  for (const run of runs) {
    const spent = run.startedAt
      ? await turnCost(tx, conversationId, run.startedAt)
      : null;
    await tx
      .update(scheduleRuns)
      .set({
        status,
        reason: why,
        finishedAt: new Date(),
        ...(spent !== null
          ? {
              costUsd: sql`coalesce(${scheduleRuns.costUsd}, 0) + ${spent}`,
            }
          : {}),
      })
      .where(eq(scheduleRuns.id, run.id));
  }
  return runs.length;
}

/**
 * What a conversation's model steps cost since a run started, where the
 * provider reported a cost.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @param since - When the run was fired.
 * @returns The sum in USD, or `null` when no step reported one.
 */
async function turnCost(
  db: DbHandle,
  conversationId: number,
  since: Date,
): Promise<string | null> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${costRecords.costUsd})` })
    .from(costRecords)
    .where(
      and(
        eq(costRecords.conversationId, conversationId),
        gte(costRecords.createdAt, since),
      ),
    );
  return row?.total ?? null;
}

/**
 * Whether the conversation's current turn is answering a schedule: a run is
 * `woken` and its message is in the transcript. Only such a turn may end
 * silently.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @returns `true` for a scheduled turn.
 */
export async function inScheduledTurn(
  db: DbHandle,
  conversationId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: scheduleRuns.id })
    .from(scheduleRuns)
    .innerJoin(
      conversationInbox,
      eq(conversationInbox.id, scheduleRuns.inboxId),
    )
    .where(
      and(
        eq(scheduleRuns.conversationId, conversationId),
        inArray(scheduleRuns.status, ["woken"]),
        sql`${conversationInbox.deliveredAt} is not null`,
      ),
    )
    .limit(1);
  return Boolean(row);
}
