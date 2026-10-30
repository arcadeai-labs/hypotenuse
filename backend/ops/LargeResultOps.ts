import { and, eq, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/mcp";
import { conversations } from "../schema/conversations";
import { type LargeResult, largeResults } from "../schema/large_results";
import type { DbHandle } from "./DbOps";

/**
 * Large results: a tool output too long to show the model whole is stored,
 * and the model gets a preview and an id it pages with `read_large_result`.
 */

/** The id a model reads: `lr_<row id>`. */
export function largeResultRef(id: number): string {
  return `lr_${id}`;
}

/**
 * Parse a model's `lr_<id>`.
 * @param ref - The reference.
 * @returns The row id, or `null`.
 */
export function parseLargeResultRef(ref: string): number | null {
  const m = /^lr_(\d{1,10})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Store a large result.
 * @param db - A database handle.
 * @param row - Where it came from and what it is.
 * @returns The stored row.
 */
export async function storeLargeResult(
  db: DbHandle,
  row: {
    projectId: number;
    conversationId: number;
    entryId: number | null;
    content: string;
    mimeType?: string;
  },
): Promise<LargeResult> {
  const [stored] = await db
    .insert(largeResults)
    .values({
      ...row,
      mimeType: row.mimeType ?? "application/json",
      totalChars: row.content.length,
    })
    .returning();
  return stored;
}

/** The preview a model gets in place of a large result. */
export interface LargeResultPreview {
  truncated: true;
  id: string;
  totalChars: number;
  preview: string;
  hint: string;
}

/**
 * Build the preview for a stored result.
 * @param row - The stored result.
 * @returns The preview.
 */
export function previewOf(row: LargeResult): LargeResultPreview {
  return {
    truncated: true,
    id: largeResultRef(row.id),
    totalChars: row.totalChars,
    preview: row.content.slice(0, config.mcp.previewChars),
    hint: `This result has ${row.totalChars} characters; only the first ${config.mcp.previewChars} are shown. Use read_large_result with id ${largeResultRef(row.id)} and an offset to read more, or call the tool again with saveTo to keep the whole result in memory.`,
  };
}

/**
 * Load a large result of a project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param id - The row id.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadLargeResult(
  db: DbHandle,
  projectId: number,
  id: number,
): Promise<LargeResult> {
  const [row] = await db
    .select()
    .from(largeResults)
    .where(and(eq(largeResults.id, id), eq(largeResults.projectId, projectId)))
    .limit(1);
  if (!row) {
    throw new TypedError({
      message: "Large result not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * One page of a large result.
 * @param row - The stored result.
 * @param offset - The first character.
 * @param limit - How many characters.
 * @returns The page, and where the next one starts.
 */
export function pageOf(row: LargeResult, offset: number, limit: number) {
  const text = row.content.slice(offset, offset + limit);
  const end = offset + text.length;
  return {
    id: largeResultRef(row.id),
    offset,
    totalChars: row.totalChars,
    text,
    nextOffset: end < row.totalChars ? end : null,
  };
}

/**
 * Shape a large result's metadata for an answer.
 * @param row - The row.
 * @returns Its metadata.
 */
export function serializeLargeResult(row: LargeResult) {
  return {
    id: row.id,
    ref: largeResultRef(row.id),
    projectId: row.projectId,
    conversationId: row.conversationId,
    entryId: row.entryId,
    mimeType: row.mimeType,
    totalChars: row.totalChars,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Delete the large results of conversations that ended more than
 * `MCP_LARGE_RESULT_RETENTION_DAYS` ago.
 * @returns How many were deleted.
 */
export async function sweepLargeResults(): Promise<number> {
  const days = config.mcp.largeResultRetentionDays;
  const deleted = await api.db.db
    .delete(largeResults)
    .where(
      sql`${largeResults.conversationId} in (
        select ${conversations.id} from ${conversations}
        where ${conversations.state} = 'ended'
          and ${conversations.updatedAt} < now() - make_interval(days => ${days})
      )`,
    )
    .returning({ id: largeResults.id });
  return deleted.length;
}
