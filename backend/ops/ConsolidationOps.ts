import { generateText, Output } from "ai";
import { and, asc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/memory";
import { bots } from "../schema/bots";
import { conversationEntries } from "../schema/conversation_entries";
import { conversations } from "../schema/conversations";
import { memoryDocuments } from "../schema/memory_documents";
import { lockConversation } from "./ConversationOps";
import { normalizeMemoryPath } from "./MemoryChunkOps";
import {
  enqueueEmbed,
  keyIn,
  type MemoryReadSet,
  scopeCondition,
  scopeFor,
  writeVersion,
} from "./MemoryOps";
import { languageModel } from "./ModelOps";
import { entryText } from "./TranscriptOps";

/**
 * **Consolidation**: after a conversation comes to rest, its bot's `fast`
 * model reads what was said since the last consolidation and writes the
 * discrete facts worth keeping into the channel's memory, under `facts/`,
 * each citing the entries it came from. A fact that replaces an older one
 * edits that document rather than adding a near-duplicate. Facts, never
 * reflections: botholomew's "dreaming" drifted into themes.
 *
 * It writes only channel memory. Nothing reaches project memory without a
 * person's promotion.
 */

/** The states a conversation is consolidated in: at rest. */
const RESTING = ["hibernating", "ended"] as const;

/** The most facts one consolidation writes. */
const MAX_FACTS = 20;

/** The most existing facts shown to the model. */
const MAX_INDEX = 200;

/** What the model returns. */
export const consolidationSchema = z.object({
  facts: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            "Where the fact lives, under facts/, such as facts/deploy-process.md",
          ),
        statement: z
          .string()
          .describe(
            "The fact, as a short markdown paragraph that stands alone",
          ),
        evidenceSeqs: z
          .array(z.number().int())
          .describe("The [seq] numbers of the entries that show it"),
        supersedes: z
          .string()
          .optional()
          .describe(
            "The path of an existing fact this one replaces, when it corrects or updates it",
          ),
      }),
    )
    .max(MAX_FACTS),
});

/** The instruction the consolidating model gets. */
const INSTRUCTIONS = `You keep a bot's memory of one channel. Read the new part of a conversation and extract the durable facts worth remembering for later conversations in this channel: decisions, commitments, names and roles, preferences, how things are done, identifiers, and dates. Skip small talk, anything only true during this conversation, and opinions about the conversation itself. Write facts, not reflections or summaries.

Each fact gets a path under facts/ (lowercase words joined by dashes, ending in .md), a statement that stands alone, and the [seq] numbers that show it. When a new fact corrects or updates an existing one, set supersedes to the existing fact's path. Return no facts when nothing is worth keeping.`;

/**
 * Whether a conversation is owed a consolidation, from its row alone.
 * @param row - The conversation's state and seqs.
 * @returns `true` when it rests with enough new entries.
 */
export function owesConsolidation(row: {
  state: string;
  lastSeq: number;
  memoryConsolidatedSeq: number;
}): boolean {
  return (
    (RESTING as readonly string[]).includes(row.state) &&
    row.lastSeq - row.memoryConsolidatedSeq >=
      config.memory.consolidateMinEntries
  );
}

/**
 * Enqueue a consolidation. Never throws: the due clock finds a lost one.
 * @param conversationId - The conversation.
 */
export async function enqueueConsolidation(
  conversationId: number,
): Promise<void> {
  try {
    await api.actions.enqueue(
      "memory:consolidate",
      { conversationId },
      "default",
    );
  } catch (e) {
    api.logger.warn("could not enqueue memory:consolidate", {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Conversations at rest that are owed a consolidation, for the due clock.
 * Only those idle for a minute, so a conversation that just rested is left
 * to the consolidation its tick enqueued.
 * @returns Their ids, at most a sweep's batch.
 */
export async function conversationsOwed(): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        inArray(conversations.state, [...RESTING]),
        sql`${conversations.lastSeq} - ${conversations.memoryConsolidatedSeq} >= ${config.memory.consolidateMinEntries}`,
        sql`${conversations.lastActivityAt} < now() - interval '1 minute'`,
      ),
    )
    .orderBy(asc(conversations.lastActivityAt))
    .limit(100);
  return rows.map((r) => r.id);
}

/**
 * The paths and descriptions of the channel's existing facts.
 * @param readSet - The conversation's read set.
 * @returns One line per fact.
 */
async function factIndex(readSet: MemoryReadSet): Promise<string> {
  const rows = await api.db.db
    .select({
      path: memoryDocuments.logicalPath,
      description: memoryDocuments.description,
    })
    .from(memoryDocuments)
    .where(
      and(
        scopeCondition(readSet, "channel"),
        eq(memoryDocuments.isCurrent, true),
        eq(memoryDocuments.tombstone, false),
        like(memoryDocuments.logicalPath, "facts/%"),
      ),
    )
    .orderBy(asc(memoryDocuments.logicalPath))
    .limit(MAX_INDEX);
  return rows.map((r) => `- ${r.path}: ${r.description}`).join("\n");
}

/**
 * A fact's path, forced under `facts/`.
 * @param raw - What the model wrote.
 * @returns The path, or `null` when it cannot be one.
 */
export function factPath(raw: string): string | null {
  const path = normalizeMemoryPath(raw.replace(/^\/*(facts\/)?/, "facts/"));
  return path && path.startsWith("facts/") ? path : null;
}

/** What one consolidation did. */
export interface ConsolidationResult {
  /** The paths written, in order. */
  written: string[];
  /** The last seq read. */
  throughSeq: number;
}

/**
 * **Consolidate a conversation once.** Reads the entries after its last
 * consolidation, asks the `fast` model for facts, and writes them with the
 * conversation's seq mark in one transaction, so a crash before commit
 * leaves the conversation owed and a repeat finds nothing new.
 * @param conversationId - The conversation.
 * @returns What was written, or `null` when nothing was owed.
 */
export async function consolidateConversation(
  conversationId: number,
): Promise<ConsolidationResult | null> {
  const [row] = await api.db.db
    .select({ conversation: conversations, bot: bots })
    .from(conversations)
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row || !owesConsolidation(row.conversation)) return null;
  const { conversation, bot } = row;
  const fromSeq = conversation.memoryConsolidatedSeq;

  const entries = await api.db.db
    .select()
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        gt(conversationEntries.seq, fromSeq),
      ),
    )
    .orderBy(asc(conversationEntries.seq));
  const throughSeq = entries.length
    ? entries[entries.length - 1].seq
    : conversation.lastSeq;
  const transcript = entries
    .filter((e) => e.kind !== "context_update" && e.kind !== "thinking")
    .map((e) => `[${e.seq}] ${e.role ?? e.kind}: ${entryText(e)}`)
    .join("\n");
  const readSet = scopeFor(conversation, bot);
  const index = await factIndex(readSet);
  const validSeqs = new Set(entries.map((e) => e.seq));

  const fast = await languageModel(bot.projectId, bot.fastModelAlias);
  const { output } = await generateText({
    model: fast.model,
    instructions: INSTRUCTIONS,
    prompt: `Existing facts in this channel:\n${index || "(none yet)"}\n\nThe new part of the conversation:\n${transcript}`,
    output: Output.object({ schema: consolidationSchema }),
    maxRetries: 2,
  });

  const written: string[] = [];
  const committed = await api.db.db.transaction(async (tx) => {
    const locked = await lockConversation(tx, conversationId);
    // Another consolidation got here first.
    if (!locked || locked.conversation.memoryConsolidatedSeq !== fromSeq) {
      return false;
    }
    for (const fact of output.facts) {
      const target =
        (fact.supersedes ? factPath(fact.supersedes) : null) ??
        factPath(fact.path);
      if (!target) continue;
      const seqs = [...new Set(fact.evidenceSeqs)]
        .filter((s) => validSeqs.has(s))
        .sort((a, b) => a - b);
      await writeVersion(tx, keyIn(readSet, "channel", target), {
        content: fact.statement.trim(),
        changeNote: fact.supersedes
          ? `Updated from conversation ${conversationId}`
          : `Learned in conversation ${conversationId}`,
        sourceType: "consolidation",
        sourceRef: { conversationId, seqs },
      });
      written.push(target);
    }
    await tx
      .update(conversations)
      .set({ memoryConsolidatedSeq: throughSeq })
      .where(eq(conversations.id, conversationId));
    return true;
  });
  if (!committed) return null;
  if (written.length > 0) await enqueueEmbed(bot.projectId);
  return { written, throughSeq };
}
