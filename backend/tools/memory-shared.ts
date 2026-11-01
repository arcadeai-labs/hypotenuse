import { and, eq, sql } from "drizzle-orm";
import { api } from "keryx";
import { z } from "zod";
import type { DbHandle, TxHandle } from "../ops/DbOps";
import {
  type DocumentKey,
  enqueueEmbed,
  keyIn,
  lockDocument,
  type MemoryReadSet,
  scopeFor,
  type VersionDraft,
  writeVersion,
} from "../ops/MemoryOps";
import { conversationEntries } from "../schema/conversation_entries";
import {
  type MemoryDocument,
  type MemoryScopeName,
  memoryDocuments,
} from "../schema/memory_documents";
import { type ToolContext, ToolError } from "./types";

/**
 * What the memory tools share: the read set every call is confined to, the
 * scope inputs, the rule that keeps a bot out of project memory, and the
 * write path with its retry dedupe. The read set always comes from the
 * conversation row the tick read — never from the model's input, which can
 * only choose between the conversation's channel and its project.
 */

/** The input choosing one scope of the conversation's read set. */
export const scopeInput = z
  .enum(["channel", "project"])
  .describe(
    "channel: what is remembered about this channel (every bot working here shares it, and no other channel sees it); project: what every bot in every channel of the project shares",
  );

/** The input choosing which scopes to look in. */
export const scopeChoiceInput = z
  .enum(["channel", "project", "both"])
  .optional()
  .describe("Where to look: channel, project, or both (the default)");

/**
 * The conversation's read set.
 * @param ctx - The call's context.
 * @returns The read set.
 */
export function readSetOf(
  ctx: Pick<ToolContext, "conversation" | "bot">,
): MemoryReadSet {
  return scopeFor(ctx.conversation, ctx.bot);
}

/**
 * Whether the binding of this conversation's channel lets its bot write
 * project memory itself. A binding records that decision, audited, where a
 * person binds a bot to a channel; until a channel has a binding, the answer
 * is no, and project memory changes only by a person's promotion.
 * @param _ctx - The call's context.
 * @returns `false`.
 */
export function bindingAllowsPromotion(
  _ctx: Pick<ToolContext, "conversation">,
): boolean {
  return false;
}

/**
 * Refuse a bot's write, edit, or forget in project memory unless its
 * channel's binding allows it.
 * @param ctx - The call's context.
 * @param scope - The scope being written.
 * @throws {ToolError} `project_write_refused`.
 */
export function assertMayChange(
  ctx: Pick<ToolContext, "conversation">,
  scope: MemoryScopeName,
): void {
  if (scope !== "project" || bindingAllowsPromotion(ctx)) return;
  throw new ToolError(
    "project_write_refused",
    "Project memory is shared by every bot in every channel of this project, so it changes only when a person promotes a memory there.",
    'Write it to scope "channel" instead, and tell the person it could be promoted to project memory from the memory explorer if everyone should know it.',
  );
}

/**
 * The 404 a model reads for a path that is not there.
 * @param path - The path.
 * @param scope - The scope.
 * @returns The error.
 */
export function notFound(path: string, scope: MemoryScopeName): ToolError {
  return new ToolError(
    "not_found",
    `There is no ${scope} memory at "${path}".`,
    "Call memory_list or memory_search to find the right path.",
  );
}

/**
 * The transcript seq of a call's intent, for provenance.
 * @param db - A database handle.
 * @param intentEntryId - The intent entry's id.
 * @returns Its seq, or `null`.
 */
async function intentSeq(
  db: DbHandle,
  intentEntryId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ seq: conversationEntries.seq })
    .from(conversationEntries)
    .where(eq(conversationEntries.id, intentEntryId))
    .limit(1);
  return row?.seq ?? null;
}

/**
 * **A bot's write.** Under the document's lock, a version this very call
 * already wrote (a retried call has the same `toolCallId`) is returned
 * instead of written twice; otherwise `change` decides the new version from
 * the current one, and it is written with the call's provenance.
 * @param ctx - The call's context.
 * @param scope - The scope.
 * @param path - The path.
 * @param change - Builds the draft from the current version, or throws a {@link ToolError}.
 * @returns The version written (or found) and whether it is new.
 */
export async function botWrite(
  ctx: ToolContext,
  scope: MemoryScopeName,
  path: string,
  change: (
    current: MemoryDocument | null,
  ) => Omit<VersionDraft, "sourceType" | "sourceRef">,
): Promise<{ row: MemoryDocument; created: boolean }> {
  assertMayChange(ctx, scope);
  const key: DocumentKey = keyIn(readSetOf(ctx), scope, path);
  const seq = await intentSeq(ctx.db, ctx.intentEntryId);
  const result = await api.db.db.transaction(async (tx: TxHandle) => {
    await lockDocument(tx, key);
    const [already] = await tx
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.projectId, key.projectId),
          eq(memoryDocuments.logicalPath, key.path),
          sql`${memoryDocuments.sourceRef} @> ${JSON.stringify({
            conversationId: ctx.conversation.id,
            toolCallId: ctx.toolCallId,
          })}::jsonb`,
        ),
      )
      .limit(1);
    if (already) return { row: already, created: false };
    const [current] = await tx
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.projectId, key.projectId),
          eq(memoryDocuments.scope, key.scope),
          key.channelId === null
            ? sql`${memoryDocuments.channelId} is null`
            : eq(memoryDocuments.channelId, key.channelId),
          eq(memoryDocuments.logicalPath, key.path),
          eq(memoryDocuments.isCurrent, true),
        ),
      )
      .limit(1);
    const draft = change(current ?? null);
    const { row } = await writeVersion(tx, key, {
      ...draft,
      sourceType: "agent",
      sourceRef: {
        conversationId: ctx.conversation.id,
        seqs: seq === null ? [] : [seq],
        toolCallId: ctx.toolCallId,
      },
    });
    return { row, created: true };
  });
  if (result.created && !result.row.tombstone) {
    await enqueueEmbed(key.projectId);
  }
  return result;
}
