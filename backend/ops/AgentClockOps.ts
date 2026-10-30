import { and, eq, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/agents";
import { conversationInbox } from "../schema/conversation_inbox";
import { type Conversation, conversations } from "../schema/conversations";
import { enqueueTick, lockConversation, wake } from "./ConversationOps";

/**
 * The clocks that keep the loop honest when a queued job is lost: Postgres
 * rows are the orchestration state, and every job is an accelerant, so these
 * find from the rows alone every tick that is owed.
 */

/**
 * Enqueue ticks for conversations, in batches. Never throws: a lost enqueue
 * is found again on the next sweep.
 * @param rows - Each conversation and the wake it is owed for.
 */
async function fanOutTicks(
  rows: { id: number; wakeRequestedAt: Date | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await api.actions.fanOut(
      "agent:tick",
      rows.map((r) => ({
        conversationId: r.id,
        wake: r.wakeRequestedAt?.getTime() ?? Date.now(),
      })),
      "agents",
    );
  } catch (e) {
    api.logger.warn("could not fan out agent ticks", {
      count: rows.length,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * `agents:reap`: every `working` conversation whose lease expired had a tick
 * die holding it. Clear the lease, owe a tick, and enqueue it; the next tick
 * recovers whatever the dead one left.
 * @returns The conversations reaped.
 */
export async function reapExpiredLeases(): Promise<number[]> {
  const reaped = await api.db.db
    .update(conversations)
    .set({
      wakeRequestedAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      sql`${conversations.id} in (
        select id from conversations
        where state = 'working' and lease_expires_at < now()
        order by lease_expires_at
        limit ${config.agents.sweepBatchSize}
        for update skip locked
      )`,
    )
    .returning({
      id: conversations.id,
      wakeRequestedAt: conversations.wakeRequestedAt,
    });
  await fanOutTicks(reaped);
  return reaped.map((r) => r.id);
}

/** What one `agents:wake-due` run did. */
export interface WakeDueResult {
  /** Owed ticks re-enqueued. */
  owed: number[];
  /** Timers that came due. */
  timers: number[];
  /** Questions nobody answered in time. */
  questionTimeouts: number[];
}

/**
 * `agents:wake-due`: re-enqueue ticks owed for longer than `wakeStaleMs` with
 * no live lease, wake conversations whose `wait_for` timer is due, and wake
 * those whose question timed out with a message saying so.
 * @returns What it did.
 */
export async function wakeDue(): Promise<WakeDueResult> {
  const limit = config.agents.sweepBatchSize;
  const staleBefore = new Date(Date.now() - config.agents.wakeStaleMs);
  const owed = await api.db.db
    .select({
      id: conversations.id,
      wakeRequestedAt: conversations.wakeRequestedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.state, "working"),
        sql`${conversations.wakeRequestedAt} < ${staleBefore}`,
        sql`(${conversations.leaseExpiresAt} is null or ${conversations.leaseExpiresAt} < now())`,
      ),
    )
    .limit(limit);
  await fanOutTicks(owed);

  const nowMs = Date.now();
  const dueTimers = await api.db.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.state, "waiting"),
        sql`${conversations.waitingOn}->>'kind' = 'timer'`,
        sql`(${conversations.waitingOn}->>'at')::bigint <= ${nowMs}`,
      ),
    )
    .limit(limit);
  const timers: number[] = [];
  for (const { id } of dueTimers) {
    const woken = await wakeIf(id, (c) =>
      c.state === "waiting" &&
      c.waitingOn?.kind === "timer" &&
      c.waitingOn.at <= Date.now()
        ? "timer"
        : null,
    );
    if (woken) timers.push(id);
  }

  const dueQuestions = await api.db.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.state, "waiting"),
        sql`${conversations.waitingOn}->>'kind' = 'answer'`,
        sql`(${conversations.waitingOn}->>'timeoutAt')::bigint <= ${nowMs}`,
      ),
    )
    .limit(limit);
  const questionTimeouts: number[] = [];
  for (const { id } of dueQuestions) {
    const woken = await wakeIf(id, (c) =>
      c.state === "waiting" &&
      c.waitingOn?.kind === "answer" &&
      c.waitingOn.timeoutAt !== null &&
      c.waitingOn.timeoutAt <= Date.now()
        ? "question_timeout"
        : null,
    );
    if (woken) questionTimeouts.push(id);
  }

  return { owed: owed.map((o) => o.id), timers, questionTimeouts };
}

/**
 * Wake one conversation if, re-checked under its lock, it is still due.
 * A timed-out question gets a system message saying nobody answered.
 * @param id - The conversation.
 * @param due - Decides, from the locked row, whether and why to wake.
 * @returns Whether it was woken.
 */
async function wakeIf(
  id: number,
  due: (c: Conversation) => "timer" | "question_timeout" | null,
): Promise<boolean> {
  const woken = await api.db.db.transaction(async (tx) => {
    const locked = await lockConversation(tx, id);
    if (!locked) return null;
    const reason = due(locked.conversation);
    if (!reason) return null;
    if (
      reason === "question_timeout" &&
      locked.conversation.waitingOn?.kind === "answer"
    ) {
      const waiting = locked.conversation.waitingOn;
      await tx
        .insert(conversationInbox)
        .values({
          conversationId: id,
          deliveryKey: `question-timeout:${waiting.questionEntryId}`,
          delivery: "queue",
          source: "system",
          text: "No answer to your question arrived before its timeout. Decide what to do without it.",
        })
        .onConflictDoNothing();
    }
    return wake(tx, locked.conversation, reason);
  });
  if (!woken) return false;
  await enqueueTick(woken);
  return true;
}
