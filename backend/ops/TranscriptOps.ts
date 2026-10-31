import type { ModelMessage } from "ai";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  type ConversationEntry,
  conversationEntries,
  type EntryKind,
} from "../schema/conversation_entries";
import { conversations } from "../schema/conversations";
import { scrubParams } from "./AuditOps";
import type { DbHandle } from "./DbOps";

/**
 * The transcript: appending entries, rebuilding the model's messages from
 * them, and shaping them for an answer. Entries are append-only; nothing here
 * edits or deletes one.
 */

/** What a caller supplies for one new entry; `seq` is allocated here. */
export interface EntryDraft {
  kind: EntryKind;
  role?: "user" | "assistant" | "tool" | null;
  content: Record<string, unknown>;
  stepId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  replay?: string | null;
  promptHash?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  userId?: number | null;
  participantId?: number | null;
}

/**
 * Append entries to a conversation's transcript, in order. Seqs come from
 * `conversations.last_seq`, incremented under the row's lock, so a tick and a
 * background compaction can never hand out the same one.
 * @param tx - An open transaction.
 * @param conversationId - The conversation.
 * @param epoch - The turn the entries belong to.
 * @param drafts - The entries.
 * @returns The inserted rows.
 */
export async function appendEntries(
  tx: DbHandle,
  conversationId: number,
  epoch: number,
  drafts: EntryDraft[],
): Promise<ConversationEntry[]> {
  if (drafts.length === 0) return [];
  const [row] = await tx
    .update(conversations)
    .set({
      lastSeq: sql`${conversations.lastSeq} + ${drafts.length}`,
      lastActivityAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({ lastSeq: conversations.lastSeq });
  const first = row.lastSeq - drafts.length + 1;
  return tx
    .insert(conversationEntries)
    .values(
      drafts.map((d, i) => ({
        conversationId,
        seq: first + i,
        epoch,
        kind: d.kind,
        role: d.role ?? null,
        content: d.content,
        stepId: d.stepId ?? null,
        toolCallId: d.toolCallId ?? null,
        toolName: d.toolName ?? null,
        replay: d.replay ?? null,
        promptHash: d.promptHash ?? null,
        inputTokens: d.inputTokens ?? null,
        outputTokens: d.outputTokens ?? null,
        durationMs: d.durationMs ?? null,
        userId: d.userId ?? null,
        participantId: d.participantId ?? null,
      })),
    )
    .returning();
}

/**
 * A tool's output made safe to store: every `SENSITIVE_KEYS` entry removed at
 * any depth, so a credential a tool saw never reaches the transcript or the
 * model's next prompt.
 * @param output - What the tool returned.
 * @returns The scrubbed copy.
 */
export function scrubToolOutput(output: unknown): unknown {
  return scrubParams({ output }).output;
}

/**
 * The latest compaction of a conversation, if any.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @returns The entry, or `undefined`.
 */
export async function latestCompaction(
  db: DbHandle,
  conversationId: number,
): Promise<ConversationEntry | undefined> {
  const [row] = await db
    .select()
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        eq(conversationEntries.kind, "compaction"),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  return row;
}

/**
 * The entries hydration reads: the latest compaction, then every entry after
 * the seq it summarized through.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @returns The compaction (if any) and the live tail, in order.
 */
export async function liveEntries(
  db: DbHandle,
  conversationId: number,
): Promise<{
  compaction: ConversationEntry | undefined;
  entries: ConversationEntry[];
}> {
  const compaction = await latestCompaction(db, conversationId);
  const throughSeq = compaction
    ? Number((compaction.content as { throughSeq: number }).throughSeq)
    : 0;
  const entries = await db
    .select()
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        gt(conversationEntries.seq, throughSeq),
      ),
    )
    .orderBy(asc(conversationEntries.seq));
  return { compaction, entries };
}

/** The opening of the user message a compaction hydrates to. */
export const SUMMARY_PREFIX = "Summary of the earlier conversation:";

/**
 * **Hydration**: rebuild the full model message list from the transcript —
 * user and assistant text, reasoning, tool calls, and tool results — so the
 * model sees exactly what it did, not just what was said. A compaction stands
 * in for everything at or before its `throughSeq`.
 * @param compaction - The latest compaction entry, if any.
 * @param entries - The entries after it, in seq order.
 * @param provider - The provider about to be called: reasoning recorded from
 *   another provider is dropped, since it cannot be handed back.
 * @returns The messages.
 */
export function hydrate(
  compaction: ConversationEntry | undefined,
  entries: ConversationEntry[],
  provider: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (compaction) {
    messages.push({
      role: "user",
      content: `${SUMMARY_PREFIX}\n\n${String((compaction.content as { summary: string }).summary)}`,
    });
  }

  type AssistantPart = Exclude<
    Extract<ModelMessage, { role: "assistant" }>["content"],
    string
  >[number];
  type ToolPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
  // Held in an object so the closures below and the loop see one value.
  const open: {
    assistant: { stepId: string | null; parts: AssistantPart[] } | null;
    tool: ToolPart[] | null;
  } = { assistant: null, tool: null };

  const flush = () => {
    if (open.assistant && open.assistant.parts.length > 0) {
      messages.push({ role: "assistant", content: open.assistant.parts });
    }
    if (open.tool && open.tool.length > 0) {
      messages.push({ role: "tool", content: open.tool });
    }
    open.assistant = null;
    open.tool = null;
  };
  const assistantFor = (stepId: string | null) => {
    if (open.tool || !open.assistant || open.assistant.stepId !== stepId) {
      flush();
      open.assistant = { stepId, parts: [] };
    }
    return open.assistant;
  };

  for (const entry of entries) {
    const content = entry.content as Record<string, unknown>;
    switch (entry.kind) {
      case "message":
        if (entry.role === "assistant") {
          const text = String(content.text ?? "");
          if (text)
            assistantFor(entry.stepId).parts.push({ type: "text", text });
        } else {
          flush();
          messages.push({ role: "user", content: userMessageText(content) });
        }
        break;
      case "thinking":
        if (content.provider === provider && content.text) {
          assistantFor(entry.stepId).parts.push({
            type: "reasoning",
            text: String(content.text),
            ...(content.providerOptions
              ? {
                  providerOptions: content.providerOptions as Record<
                    string,
                    Record<string, never>
                  >,
                }
              : {}),
          });
        }
        break;
      case "tool_call_intent":
        assistantFor(entry.stepId).parts.push({
          type: "tool-call",
          toolCallId: String(entry.toolCallId),
          toolName: String(entry.toolName),
          input: content.input ?? {},
        });
        break;
      case "tool_result": {
        if (open.assistant) {
          if (open.assistant.parts.length > 0) {
            messages.push({ role: "assistant", content: open.assistant.parts });
          }
          open.assistant = null;
        }
        open.tool ??= [];
        const output = content.output;
        const isError =
          typeof output === "object" &&
          output !== null &&
          (output as { is_error?: unknown }).is_error === true;
        open.tool.push({
          type: "tool-result",
          toolCallId: String(entry.toolCallId),
          toolName: String(entry.toolName),
          output: isError
            ? { type: "error-json", value: output as never }
            : { type: "json", value: (output ?? null) as never },
        });
        break;
      }
      case "status_change":
        if (content.visibleToModel && content.text) {
          flush();
          messages.push({ role: "user", content: String(content.text) });
        }
        break;
      default:
        // `context_update` is for people; a nested `compaction` is
        // superseded by the latest one.
        break;
    }
  }
  flush();
  return messages;
}

/**
 * What the model reads for a person's message: its text, or — for a message
 * that invoked a skill — the skill's expansion in its place.
 * @param content - The message entry's content.
 * @returns The text.
 */
export function userMessageText(content: Record<string, unknown>): string {
  const text = String(content.text ?? "");
  const skill = content.skill as
    | { name: string; text: string | null; error?: string }
    | undefined;
  if (!skill) return text;
  if (skill.text !== null) {
    return `${text}\n\n(This message ran the skill /${skill.name}. Its instructions, filled in:)\n\n${skill.text}`;
  }
  return `${text}\n\n(This message tried to run the skill /${skill.name}, which could not be filled in: ${skill.error ?? "its arguments did not fit."} Tell the person what the skill needs.)`;
}

/**
 * One line of text for an entry, for search and for summaries.
 * @param entry - The entry.
 * @returns Its text.
 */
export function entryText(entry: ConversationEntry): string {
  const content = entry.content as Record<string, unknown>;
  switch (entry.kind) {
    case "message":
    case "thinking":
    case "status_change":
      return String(content.text ?? "");
    case "tool_call_intent":
      return `${entry.toolName}(${JSON.stringify(content.input ?? {})})`;
    case "tool_result":
      return `${entry.toolName} → ${JSON.stringify(content.output ?? null)}`;
    case "compaction":
      return String(content.summary ?? "");
    case "context_update":
      return (content.skill as { name?: string } | undefined)?.name
        ? `The skill /${(content.skill as { name: string }).name} was expanded.`
        : `The system prompt changed (${entry.promptHash ?? "unknown"}).`;
    default:
      return JSON.stringify(content);
  }
}

/**
 * Whether a stored tool result is the interrupted-call error.
 * @param entry - A `tool_result` entry.
 * @returns `true` when recovery settled it as interrupted.
 */
export function isInterrupted(entry: ConversationEntry): boolean {
  const output = (entry.content as { output?: { error_type?: unknown } })
    .output;
  return (
    entry.kind === "tool_result" &&
    typeof output === "object" &&
    output !== null &&
    output.error_type === "interrupted"
  );
}

/**
 * Shape an entry for any answer. Timestamps are epoch ms.
 * @param entry - The row.
 * @returns The serialized entry.
 */
export function serializeEntry(entry: ConversationEntry) {
  return {
    id: entry.id,
    conversationId: entry.conversationId,
    seq: entry.seq,
    epoch: entry.epoch,
    stepId: entry.stepId,
    kind: entry.kind,
    role: entry.role,
    content: entry.content,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    replay: entry.replay,
    interrupted: isInterrupted(entry),
    promptHash: entry.promptHash,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    durationMs: entry.durationMs,
    userId: entry.userId,
    participantId: entry.participantId,
    createdAt: entry.createdAt.getTime(),
  };
}
