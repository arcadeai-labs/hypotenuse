import { createHash } from "node:crypto";
import { embedMany } from "ai";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  like,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/memory";
import type { Bot } from "../schema/bots";
import type { Conversation } from "../schema/conversations";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  memoryChunks,
} from "../schema/memory_chunks";
import {
  type MemoryDocument,
  type MemoryScopeName,
  type MemorySourceRef,
  type MemorySourceType,
  memoryDocuments,
} from "../schema/memory_documents";
import type { DbHandle, TxHandle } from "./DbOps";
import {
  buildSearchText,
  chunkDocument,
  DESCRIPTION_MAX_CHARS,
  truncateAtWord,
} from "./MemoryChunkOps";
import { embeddingModel } from "./ModelOps";

/**
 * **Memory**: versioned markdown documents in two scopes, the read set a
 * conversation may see, and the queue that embeds what was written. Every
 * write a bot, a person, or a clock makes goes through {@link writeVersion};
 * every read names its scope in SQL.
 *
 * | Scope | Key | Who reads it |
 * |---|---|---|
 * | `channel` | `(projectId, channelId)` | every bot, in conversations in that channel; people who may read a bot working there |
 * | `project` | `projectId` | every bot and channel of the project; every member |
 */

/** The days a memory takes to lose half its weight, when no bot says otherwise. */
export const DEFAULT_HALF_LIFE_DAYS = { channel: 30, project: 180 } as const;

/**
 * **The read set**: what one conversation (or one person's view) may see.
 * Built server-side from a conversation row by {@link scopeFor}, never from
 * input a model wrote. `channel` is absent for a project-only view.
 */
export interface MemoryReadSet {
  projectId: number;
  channel: { channelId: number } | null;
  /** Half-lives in days, for ranking. */
  halfLifeDays: { channel: number; project: number };
}

/**
 * The read set of a conversation: its channel, and its project. Every bot in
 * the channel shares its memory; the bot only sets the half-lives it ranks by.
 * @param conversation - The conversation row.
 * @param bot - Its bot, for its half-lives.
 * @returns The read set.
 */
export function scopeFor(
  conversation: Pick<Conversation, "projectId" | "channelId">,
  bot: Pick<Bot, "memoryChannelHalfLifeDays" | "memoryProjectHalfLifeDays">,
): MemoryReadSet {
  return {
    projectId: conversation.projectId,
    channel: { channelId: conversation.channelId },
    halfLifeDays: {
      channel: bot.memoryChannelHalfLifeDays,
      project: bot.memoryProjectHalfLifeDays,
    },
  };
}

/** Which part of a read set a call looks at. */
export type ScopeChoice = MemoryScopeName | "both";

/** One document's address. */
export interface DocumentKey {
  projectId: number;
  scope: MemoryScopeName;
  /** Set iff `scope` is `channel`. */
  channelId: number | null;
  path: string;
}

/**
 * The key of a document in one scope of a read set.
 * @param readSet - The read set.
 * @param scope - Which of its scopes.
 * @param path - The document's path.
 * @returns The key.
 * @throws {Error} For `channel` on a read set without one (a caller's bug).
 */
export function keyIn(
  readSet: MemoryReadSet,
  scope: MemoryScopeName,
  path: string,
): DocumentKey {
  if (scope === "project") {
    return {
      projectId: readSet.projectId,
      scope,
      channelId: null,
      path,
    };
  }
  if (!readSet.channel) throw new Error("This read set has no channel");
  return {
    projectId: readSet.projectId,
    scope,
    channelId: readSet.channel.channelId,
    path,
  };
}

/**
 * The SQL condition for one scope of a read set, over `memory_documents`.
 * The channel condition always names the channel: this is the memory
 * boundary, and it is enforced here, in the `WHERE` of every query.
 * @param readSet - The read set.
 * @param choice - `channel`, `project`, or `both`.
 * @returns The condition.
 */
export function scopeCondition(
  readSet: MemoryReadSet,
  choice: ScopeChoice,
): SQL {
  const project = and(
    eq(memoryDocuments.projectId, readSet.projectId),
    eq(memoryDocuments.scope, "project"),
  ) as SQL;
  const channel = readSet.channel
    ? (and(
        eq(memoryDocuments.projectId, readSet.projectId),
        eq(memoryDocuments.scope, "channel"),
        eq(memoryDocuments.channelId, readSet.channel.channelId),
      ) as SQL)
    : sql`false`;
  if (choice === "project") return project;
  if (choice === "channel") return channel;
  return or(project, channel) as SQL;
}

/**
 * The SQL condition naming every version of one document.
 * @param key - The document.
 * @returns The condition.
 */
function keyCondition(key: DocumentKey): SQL {
  return and(
    eq(memoryDocuments.projectId, key.projectId),
    eq(memoryDocuments.scope, key.scope),
    key.channelId === null
      ? isNull(memoryDocuments.channelId)
      : eq(memoryDocuments.channelId, key.channelId),
    eq(memoryDocuments.logicalPath, key.path),
  ) as SQL;
}

/**
 * A document's current version, tombstone or not.
 * @param db - A database handle.
 * @param key - The document.
 * @param options.lock - Take `FOR UPDATE`.
 * @returns The row, or `null` when it was never written.
 */
export async function currentVersion(
  db: DbHandle,
  key: DocumentKey,
  options: { lock?: boolean } = {},
): Promise<MemoryDocument | null> {
  const query = db
    .select()
    .from(memoryDocuments)
    .where(and(keyCondition(key), eq(memoryDocuments.isCurrent, true)))
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

/**
 * One version of a document: the current one, or the one with this version id.
 * @param db - A database handle.
 * @param key - The document.
 * @param versionId - The version (epoch ms), or omit for the current one.
 * @returns The row, or `null`.
 */
export async function readVersion(
  db: DbHandle,
  key: DocumentKey,
  versionId?: number,
): Promise<MemoryDocument | null> {
  if (versionId === undefined) return currentVersion(db, key);
  const [row] = await db
    .select()
    .from(memoryDocuments)
    .where(
      and(
        keyCondition(key),
        eq(memoryDocuments.versionId, new Date(versionId)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Every version of a document, newest first, paginated.
 * @param db - A database handle.
 * @param key - The document.
 * @param page - Zero-based page.
 * @param limit - Rows per page.
 * @returns The rows and the total.
 */
export async function listVersions(
  db: DbHandle,
  key: DocumentKey,
  page: number,
  limit: number,
): Promise<{ rows: MemoryDocument[]; total: number }> {
  const rows = await db
    .select()
    .from(memoryDocuments)
    .where(keyCondition(key))
    .orderBy(sql`${memoryDocuments.versionId} desc`)
    .limit(limit)
    .offset(page * limit);
  const [{ total }] = await db
    .select({ total: count() })
    .from(memoryDocuments)
    .where(keyCondition(key));
  return { rows, total };
}

/** What a new version says and where it came from. */
export interface VersionDraft {
  content: string;
  /** Omit to keep the previous version's, or derive one from the content. */
  description?: string;
  changeNote: string | null;
  sourceType: MemorySourceType;
  sourceRef: MemorySourceRef;
  authorUserId?: number | null;
  tombstone?: boolean;
  /** Set the pin; omit to carry it over. */
  pinned?: boolean;
}

/**
 * A description for a document that was given none: its first heading or
 * line, cut at {@link DESCRIPTION_MAX_CHARS}.
 * @param content - The document.
 * @returns The description.
 */
export function deriveDescription(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l !== "") ?? "";
  return truncateAtWord(line, DESCRIPTION_MAX_CHARS);
}

/**
 * **Write a version.** Serialize writers of this one document with a
 * transaction-scoped advisory lock (a first write has no row to lock), then
 * insert the new row with a `versionId` later than the current one's, mark
 * the old one not current, and replace the chunks. Pin, access count, and last
 * access carry over. The caller's transaction commits it all, so a crash
 * leaves the old version current and searchable.
 * @param tx - An open transaction.
 * @param key - The document.
 * @param draft - The version.
 * @returns The new row and the one it replaced.
 */
export async function writeVersion(
  tx: TxHandle,
  key: DocumentKey,
  draft: VersionDraft,
): Promise<{ row: MemoryDocument; previous: MemoryDocument | null }> {
  await lockDocument(tx, key);
  const previous = await currentVersion(tx, key, { lock: true });
  const now = Date.now();
  const versionId = new Date(
    previous ? Math.max(now, previous.versionId.getTime() + 1) : now,
  );
  if (previous) {
    await tx
      .update(memoryDocuments)
      .set({ isCurrent: false })
      .where(eq(memoryDocuments.id, previous.id));
    await tx
      .delete(memoryChunks)
      .where(eq(memoryChunks.documentId, previous.id));
  }
  const tombstone = draft.tombstone ?? false;
  const description = tombstone
    ? (previous?.description ?? "")
    : draft.description !== undefined
      ? truncateAtWord(draft.description.trim(), DESCRIPTION_MAX_CHARS)
      : previous && !previous.tombstone && previous.description
        ? previous.description
        : deriveDescription(draft.content);
  const [row] = await tx
    .insert(memoryDocuments)
    .values({
      projectId: key.projectId,
      scope: key.scope,
      channelId: key.channelId,
      logicalPath: key.path,
      versionId,
      isCurrent: true,
      tombstone,
      content: tombstone ? "" : draft.content,
      description,
      changeNote: draft.changeNote,
      pinned: draft.pinned ?? previous?.pinned ?? false,
      sourceType: draft.sourceType,
      sourceRef: draft.sourceRef,
      authorUserId: draft.authorUserId ?? null,
      lastAccessedAt: previous?.lastAccessedAt ?? null,
      accessCount: previous?.accessCount ?? 0,
    })
    .returning();
  if (!tombstone) {
    const chunks = chunkDocument(row.content);
    if (chunks.length > 0) {
      await tx.insert(memoryChunks).values(
        chunks.map((c) => ({
          documentId: row.id,
          projectId: row.projectId,
          chunkIndex: c.index,
          breadcrumb: c.breadcrumb,
          body: c.body,
          searchText: buildSearchText(row.logicalPath, row.description, c),
        })),
      );
    }
  }
  return { row, previous };
}

/**
 * Take the transaction-scoped advisory lock that serializes writers of one
 * document. Re-entrant within a transaction, so a caller that checks
 * something before {@link writeVersion} may take it first. **Every** change
 * to a document takes it before any row lock on the document: one path that
 * row-locked first would deadlock against one that did not.
 * @param tx - An open transaction.
 * @param key - The document.
 */
export async function lockDocument(
  tx: TxHandle,
  key: DocumentKey,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${documentLockKey(key)}, 0))`,
  );
}

/**
 * The advisory-lock key of one document.
 * @param key - The document.
 * @returns A string unique to it.
 */
function documentLockKey(key: DocumentKey): string {
  return `memory:${key.projectId}:${key.scope}:${key.channelId ?? 0}:${key.path}`;
}

/**
 * Change only a document's pin, in place on its current version: pinning is
 * about the document, not its words, so it makes no new version.
 * @param tx - An open transaction.
 * @param key - The document.
 * @param pinned - The new pin.
 * @returns The updated current row, or `null` when there is no live document.
 */
export async function setPinned(
  tx: TxHandle,
  key: DocumentKey,
  pinned: boolean,
): Promise<MemoryDocument | null> {
  // The writers' lock first: without it, a write committing meanwhile moves
  // `is_current`, and the re-checked `FOR UPDATE` below finds no row.
  await lockDocument(tx, key);
  const current = await currentVersion(tx, key, { lock: true });
  if (!current || current.tombstone) return null;
  const [row] = await tx
    .update(memoryDocuments)
    .set({ pinned })
    .where(eq(memoryDocuments.id, current.id))
    .returning();
  return row;
}

/**
 * Record that documents were used: their last access moves to now and their
 * count goes up, which slows their decay. One `UPDATE` per call.
 * @param db - A database handle.
 * @param ids - The current versions' row ids.
 */
export async function touchDocuments(
  db: DbHandle,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memoryDocuments)
    .set({
      lastAccessedAt: sql`now()`,
      accessCount: sql`${memoryDocuments.accessCount} + 1`,
    })
    .where(
      and(
        inArray(memoryDocuments.id, [...new Set(ids)]),
        eq(memoryDocuments.isCurrent, true),
      ),
    );
}

/**
 * The live documents of a read set, by path.
 * @param db - A database handle.
 * @param readSet - The read set.
 * @param choice - Which scopes.
 * @param options.pathPrefix - Only paths starting with this.
 * @param options.limit - At most this many.
 * @param options.offset - Skip this many.
 * @param options.includeForgotten - Include tombstoned documents.
 * @returns The current rows and the total.
 */
export async function listDocuments(
  db: DbHandle,
  readSet: MemoryReadSet,
  choice: ScopeChoice,
  options: {
    pathPrefix?: string;
    limit: number;
    offset: number;
    includeForgotten?: boolean;
  },
): Promise<{ rows: MemoryDocument[]; total: number }> {
  const where = and(
    scopeCondition(readSet, choice),
    eq(memoryDocuments.isCurrent, true),
    options.includeForgotten ? undefined : eq(memoryDocuments.tombstone, false),
    options.pathPrefix
      ? like(memoryDocuments.logicalPath, `${escapeLike(options.pathPrefix)}%`)
      : undefined,
  );
  const rows = await db
    .select()
    .from(memoryDocuments)
    .where(where)
    .orderBy(asc(memoryDocuments.scope), asc(memoryDocuments.logicalPath))
    .limit(options.limit)
    .offset(options.offset);
  const [{ total }] = await db
    .select({ total: count() })
    .from(memoryDocuments)
    .where(where);
  return { rows, total };
}

/**
 * Escape `%`, `_`, and `\` for a `LIKE` pattern.
 * @param text - The literal text.
 * @returns The escaped text.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * How much of a memory's weight is left: `exp(−ln 2 · age / halfLife)`, where
 * age runs from its newest version or its last use, whichever is later. A
 * pinned memory never decays.
 * @param row - The current version.
 * @param halfLifeDays - The half-life for its scope.
 * @param now - The time to measure at (epoch ms).
 * @returns A factor in (0, 1].
 */
export function decayFactor(
  row: Pick<MemoryDocument, "pinned" | "createdAt" | "lastAccessedAt">,
  halfLifeDays: number,
  now = Date.now(),
): number {
  if (row.pinned) return 1;
  const since = Math.max(
    row.createdAt.getTime(),
    row.lastAccessedAt?.getTime() ?? 0,
  );
  const ageDays = Math.max(0, now - since) / 86_400_000;
  return Math.exp((-Math.LN2 * ageDays) / Math.max(halfLifeDays, 1e-9));
}

/**
 * The half-life that applies to a row in a read set.
 * @param readSet - The read set.
 * @param row - The row.
 * @returns Days.
 */
export function halfLifeFor(
  readSet: MemoryReadSet,
  row: Pick<MemoryDocument, "scope">,
): number {
  return row.scope === "channel"
    ? readSet.halfLifeDays.channel
    : readSet.halfLifeDays.project;
}

/**
 * The record of a document's text an audit row keeps: its length and digest.
 * @param content - The text.
 * @returns The summary.
 */
function summarizeContent(content: string) {
  return {
    length: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

/**
 * Shape a version for any answer. Timestamps are epoch ms, and `versionId`
 * is the version's epoch ms — the value every edit names as its base.
 * @param row - The version.
 * @param options.content - Include the text (`false` for lists and audit rows).
 * @param options.decay - The decay factor to report, when known.
 * @returns The serialized version.
 */
export function serializeMemoryDocument(
  row: MemoryDocument,
  options: { content?: boolean; decay?: number } = {},
) {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    channelId: row.channelId,
    path: row.logicalPath,
    versionId: row.versionId.getTime(),
    current: row.isCurrent,
    forgotten: row.tombstone,
    description: row.description,
    changeNote: row.changeNote,
    pinned: row.pinned,
    sourceType: row.sourceType,
    provenance: row.sourceRef,
    authorUserId: row.authorUserId,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    ...(options.decay !== undefined
      ? { decay: Math.round(options.decay * 10_000) / 10_000 }
      : {}),
    ...(options.content ? { content: row.content } : {}),
  };
}

/**
 * Shape a version for an audit row: never its words, only their length and
 * digest, as a conversation's message is audited. The description is often
 * the text's first line, so it is digested too.
 * @param row - The version.
 * @returns The snapshot.
 */
export function auditMemoryDocument(row: MemoryDocument) {
  return {
    ...serializeMemoryDocument(row),
    description: summarizeContent(row.description),
    content: summarizeContent(row.content),
  };
}

/** The 404 every unreadable or missing document answers with. */
export function memoryNotFound(): TypedError {
  return new TypedError({
    message: "Memory document not found",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/** The Redis key that marks an embed run as queued or running for a project. */
function embedKey(projectId: number): string {
  return `hyp:memory-embed:${projectId}`;
}

/** How long the mark lives if its run dies, in seconds. */
const EMBED_PENDING_TTL_SECONDS = 300;

/**
 * Queue `memory:embed` for a project unless one is already queued or
 * running. Never throws: a write has committed, and a lost or failed run is
 * retried by the next write, the next reindex, or the project's hourly decay
 * run, which enqueues one.
 * @param projectId - The project.
 */
export async function enqueueEmbed(projectId: number): Promise<void> {
  try {
    const set = await api.redis.redis.set(
      embedKey(projectId),
      "1",
      "EX",
      EMBED_PENDING_TTL_SECONDS,
      "NX",
    );
    if (set !== "OK") return;
    await api.actions.enqueue("memory:embed", { projectId }, "default");
  } catch (e) {
    await api.redis.redis.del(embedKey(projectId)).catch(() => {});
    api.logger.warn("could not enqueue memory:embed", {
      projectId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The SQL condition for a chunk that needs a vector under `revision`.
 * @param revision - The project's current embedding revision.
 * @returns The condition.
 */
function staleChunk(revision: string): SQL {
  return or(
    isNull(memoryChunks.embeddingRevision),
    ne(memoryChunks.embeddingRevision, revision),
  ) as SQL;
}

/**
 * How many of a project's chunks have no vector for its current embedding
 * model (all of them, when it has none).
 * @param db - A database handle.
 * @param projectId - The project.
 * @param revision - The current revision, or `null` when there is no model.
 * @returns The count.
 */
export async function staleChunkCount(
  db: DbHandle,
  projectId: number,
  revision: string | null,
): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(memoryChunks)
    .where(
      and(
        eq(memoryChunks.projectId, projectId),
        revision === null ? undefined : staleChunk(revision),
      ),
    );
  return n;
}

/**
 * **Embed** one batch of a project's chunks that lack a vector for its
 * current embedding model, then re-enqueue while any remain. A chunk deleted
 * meanwhile simply updates nothing. Without an embedding model there is
 * nothing to do: memory ranks by keyword.
 * @param projectId - The project.
 * @returns How many chunks were embedded, and how many still wait.
 */
export async function embedPending(
  projectId: number,
): Promise<{ embedded: number; remaining: number }> {
  let more = false;
  try {
    const model = await embeddingModel(projectId);
    if (!model) return { embedded: 0, remaining: 0 };
    const batch = await api.db.db
      .select({ id: memoryChunks.id, searchText: memoryChunks.searchText })
      .from(memoryChunks)
      .where(
        and(eq(memoryChunks.projectId, projectId), staleChunk(model.revision)),
      )
      .orderBy(asc(memoryChunks.id))
      .limit(config.memory.embedBatchSize);
    if (batch.length === 0) return { embedded: 0, remaining: 0 };
    const { embeddings } = await embedMany({
      model: model.model,
      values: batch.map((c) => c.searchText),
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      maxRetries: 2,
    });
    await api.db.db.transaction(async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        await tx
          .update(memoryChunks)
          .set({
            embedding: embeddings[i],
            embeddingRevision: model.revision,
          })
          .where(eq(memoryChunks.id, batch[i].id));
      }
    });
    const remaining = await staleChunkCount(
      api.db.db,
      projectId,
      model.revision,
    );
    more = remaining > 0;
    return { embedded: batch.length, remaining };
  } finally {
    await api.redis.redis.del(embedKey(projectId));
    if (more) await enqueueEmbed(projectId);
  }
}
