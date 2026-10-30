import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { bots } from "../schema/bots";
import type { ConversationEntry } from "../schema/conversation_entries";
import { conversations } from "../schema/conversations";
import { lockConversation, openIntents } from "./ConversationOps";
import { languageModel } from "./ModelOps";
import { appendEntries, entryText, liveEntries } from "./TranscriptOps";

/**
 * Background compaction: when a conversation's prompt nears its model's
 * window, its older turns are summarized by the bot's `fast` model into a
 * `compaction` entry, and hydration sends that summary instead of them.
 * Nothing is deleted — `search_history` still reaches every entry — and no
 * lease is taken: compaction runs beside the conversation, appending under
 * the row lock like any other writer.
 */

/** The Redis key that marks a compaction as queued or running. */
function pendingKey(conversationId: number): string {
  return `hyp:compaction:${conversationId}`;
}

/** How long the pending mark lives if its compaction dies, in seconds. */
const PENDING_TTL_SECONDS = 600;

/**
 * Whether a compaction is queued or running for a conversation.
 * @param conversationId - The conversation.
 * @returns `true` if one is.
 */
export async function compactionPending(
  conversationId: number,
): Promise<boolean> {
  return (await api.redis.redis.exists(pendingKey(conversationId))) === 1;
}

/**
 * Queue a compaction unless one is already queued or running.
 * @param conversationId - The conversation.
 * @returns `true` when a compaction is now pending (queued here or before).
 */
export async function maybeEnqueueCompaction(
  conversationId: number,
): Promise<boolean> {
  const set = await api.redis.redis.set(
    pendingKey(conversationId),
    "1",
    "EX",
    PENDING_TTL_SECONDS,
    "NX",
  );
  if (set !== "OK") return true;
  try {
    await api.actions.enqueue(
      "conversation:compact",
      { conversationId },
      "agents",
    );
    return true;
  } catch (e) {
    await api.redis.redis.del(pendingKey(conversationId));
    api.logger.warn("could not enqueue a compaction", {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Where a compaction may cut: just before the newest message a person sent,
 * the start of the most recent turn. Every intent at or before the cut must
 * already have its result, so the summary never splits a call from its answer.
 * @param entries - The live tail, in order.
 * @param afterSeq - The previous compaction's cut.
 * @param openSeqs - Seqs of intents with no result.
 * @returns The seq to summarize through, or `null` when there is nothing to do.
 */
export function compactionCut(
  entries: ConversationEntry[],
  afterSeq: number,
  openSeqs: number[],
): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== "message" || e.role !== "user") continue;
    const cut = e.seq - 1;
    if (cut <= afterSeq) return null;
    if (openSeqs.some((s) => s <= cut)) continue;
    // A cut that would summarize no message (only the first turn's opening
    // state change) summarizes nothing worth a model call.
    if (!entries.some((x) => x.seq <= cut && x.kind === "message")) {
      return null;
    }
    return cut;
  }
  return null;
}

/** The instruction the summarizing model gets. */
const SUMMARY_INSTRUCTIONS =
  "You summarize the earlier part of a conversation between people and a bot, so the bot can continue it without the full text. Keep every fact, decision, open question, commitment, name, number, and identifier; say which tools were called and what they returned when it matters. Write plain prose and short lists, no preamble.";

/**
 * Compact a conversation once: summarize everything up to the most recent
 * turn boundary and append a `compaction` entry. When there is nothing to
 * cut, the size that asked for this is forgotten, so a tick waiting on it
 * goes ahead.
 * @param conversationId - The conversation.
 * @returns The seq summarized through, or `null`.
 */
export async function compactConversation(
  conversationId: number,
): Promise<number | null> {
  try {
    const [row] = await api.db.db
      .select({ conversation: conversations, bot: bots })
      .from(conversations)
      .innerJoin(bots, eq(bots.id, conversations.botId))
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return null;
    const { compaction, entries } = await liveEntries(
      api.db.db,
      conversationId,
    );
    const afterSeq = compaction
      ? Number((compaction.content as { throughSeq: number }).throughSeq)
      : 0;
    const open = await openIntents(api.db.db, conversationId);
    const cut = compactionCut(
      entries,
      afterSeq,
      open.map((o) => o.seq),
    );
    if (cut === null) {
      await forgetSize(conversationId);
      return null;
    }

    const earlier = entries
      .filter((e) => e.seq <= cut && e.kind !== "context_update")
      .map((e) => `[${e.seq}] ${e.role ?? e.kind}: ${entryText(e)}`)
      .join("\n");
    const previous = compaction
      ? `Summary so far:\n${String((compaction.content as { summary: string }).summary)}\n\nWhat followed:\n`
      : "";
    const fast = await languageModel(row.bot.projectId, row.bot.fastModelAlias);
    const { text } = await generateText({
      model: fast.model,
      instructions: SUMMARY_INSTRUCTIONS,
      prompt: `${previous}${earlier}`,
      maxRetries: 2,
    });

    await api.db.db.transaction(async (tx) => {
      const locked = await lockConversation(tx, conversationId);
      if (!locked) return;
      await appendEntries(tx, conversationId, locked.conversation.epoch, [
        {
          kind: "compaction",
          content: {
            throughSeq: cut,
            summary: text,
            model: fast.modelId,
            previousThroughSeq: afterSeq,
          },
        },
      ]);
      await tx
        .update(conversations)
        .set({ lastInputTokens: null })
        .where(eq(conversations.id, conversationId));
    });
    return cut;
  } finally {
    await api.redis.redis.del(pendingKey(conversationId));
  }
}

/**
 * Forget the prompt size that called for a compaction.
 * @param conversationId - The conversation.
 */
async function forgetSize(conversationId: number): Promise<void> {
  await api.db.db
    .update(conversations)
    .set({ lastInputTokens: null })
    .where(eq(conversations.id, conversationId));
}
