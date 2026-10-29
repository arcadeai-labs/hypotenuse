import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { type Tag, tags } from "../schema/tags";
import type { DbHandle, TxHandle } from "./DbOps";
import { isAdmin } from "./MembershipOps";
import { normalizeTagName } from "./TagOps";

/**
 * Per-object access lists: **the one implementation** behind every `accessRead`
 * and `accessWrite` in Hypotenuse.
 *
 * An object carries two lists of tag names. Who satisfies a list:
 *
 * | List contents | Who satisfies it |
 * |---|---|
 * | any list, caller has admin standing (an organization owner included) | everyone with that standing |
 * | `[]` (empty) | every project member |
 * | contains `*` ({@link ACCESS_EVERYONE}) | every project member |
 * | tag names | members holding any named tag (case-insensitive, trimmed) |
 *
 * Enforced **inside actions, never in middleware**: the rule lives on the row,
 * and middleware runs before the row is loaded. Middleware gates membership;
 * this module gates the object. Admins short-circuit because somebody has to be
 * able to fix an object whose list locked its author out, and an empty list
 * means everyone because a list nobody can satisfy is never what an author meant.
 */

/** The access-list entry meaning "every member of the project". */
export const ACCESS_EVERYONE = "*";

/**
 * Whether a caller's tags satisfy an access list.
 * @param list - The `accessRead` or `accessWrite` tag names.
 * @param callerTags - The caller's tags in the object's project, as the RBAC
 *   middleware resolved them (an owner's include the `admin` tag).
 * @returns `true` if the caller passes.
 */
export function satisfiesAccess(list: string[], callerTags: Tag[]): boolean {
  if (isAdmin(callerTags)) return true;
  if (list.length === 0) return true;
  if (list.some((entry) => entry.trim() === ACCESS_EVERYONE)) return true;
  const held = new Set(callerTags.map((t) => normalizeTagName(t.name)));
  return list.some((entry) => held.has(normalizeTagName(entry)));
}

/**
 * Refuse a tag named `*`. Access lists match `*` as "every member" before they
 * match any name, so a tag called that would grant nothing, and renaming a tag
 * to it would turn every list naming the tag into "everyone".
 * @param name - The tag name being created or renamed to.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export function assertNotAccessEveryone(name: string): void {
  if (name.trim() === ACCESS_EVERYONE) {
    throw new TypedError({
      message: `"${ACCESS_EVERYONE}" means every member in an access list, so it cannot be a tag's name`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "name",
    });
  }
}

/** Any row that carries access lists. */
export interface AccessControlled {
  accessRead: string[];
  accessWrite: string[];
}

/**
 * Whether a caller may see an object.
 * @param row - The object.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if they may read it.
 */
export function canRead(row: AccessControlled, callerTags: Tag[]): boolean {
  return satisfiesAccess(row.accessRead, callerTags);
}

/**
 * Whether a caller may change or delete an object.
 * @param row - The object.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if they may write it.
 */
export function canWrite(row: AccessControlled, callerTags: Tag[]): boolean {
  return satisfiesAccess(row.accessWrite, callerTags);
}

/**
 * A table whose rows carry access lists, described by its columns. Every such
 * table registers itself with {@link registerAccessListTable}, which is how
 * `tag:delete` and `tag:edit` find every list that names a tag without knowing
 * which features exist.
 */
export interface AccessListTable {
  /** What the rows are, in a refusal a person reads: `"bot"`. */
  kind: string;
  table: PgTable;
  id: PgColumn;
  projectId: PgColumn;
  /** The column that names a row to a person. */
  label: PgColumn;
  accessRead: PgColumn;
  accessWrite: PgColumn;
  /**
   * Text columns that each name one tag (a bot's `helpNotifyTag`): renamed with
   * the tag, and a tag they name cannot be deleted, exactly like a list entry.
   */
  tagColumns?: PgColumn[];
}

/** Every registered table, keyed by `kind`. */
const accessListTables = new Map<string, AccessListTable>();

/**
 * Register a table whose rows carry access lists. Call it once, from the module
 * that defines the feature's ops, so the registration exists wherever the table
 * is used. Registering a `kind` twice replaces the first.
 * @param definition - The table and its columns.
 */
export function registerAccessListTable(definition: AccessListTable): void {
  accessListTables.set(definition.kind, definition);
}

/**
 * Forget a registered table. For a suite that registers a table only it creates.
 * @param kind - The `kind` it was registered under.
 */
export function unregisterAccessListTable(kind: string): void {
  accessListTables.delete(kind);
}

/**
 * The ids of a project's rows a caller may read.
 *
 * What lets a list of something-readable filter, count, and page in SQL: a list
 * is a `jsonb` array of names matched case-insensitively — not a predicate
 * Postgres can evaluate without a second copy of {@link canRead} — so resolve the
 * readable ids first and filter the page with `IN (…)`.
 * @param db - A database handle.
 * @param definition - The table.
 * @param projectId - The project.
 * @param callerTags - The caller's tags in it.
 * @returns The readable ids.
 */
export async function readableIds(
  db: DbHandle,
  definition: AccessListTable,
  projectId: number,
  callerTags: Tag[],
): Promise<number[]> {
  const rows = (await db
    .select({ id: definition.id, accessRead: definition.accessRead })
    .from(definition.table)
    .where(eq(definition.projectId, projectId))) as {
    id: number;
    accessRead: string[];
  }[];
  return rows
    .filter((row) => satisfiesAccess(row.accessRead, callerTags))
    .map((row) => row.id);
}

/**
 * The Zod input for an access list: up to fifty trimmed, lowercased, unique
 * names. Whether each names a tag that exists is a database question, answered by
 * {@link assertAccessListTags} inside the action that writes the list.
 */
export const accessListSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "An access list entry cannot be empty")
      .max(256),
  )
  .max(50, "An access list names at most 50 tags")
  .transform((entries) => [...new Set(entries)])
  .describe(
    `Tag names allowed; "${ACCESS_EVERYONE}" or an empty list means every project member. Admins always pass.`,
  );

/**
 * Refuse an access list naming a tag the project does not have. A typo in a list
 * would otherwise grant nothing today and silently grant whoever is given a tag
 * of that name tomorrow.
 * @param db - A database handle (the writing transaction).
 * @param projectId - The project.
 * @param list - The normalized list from {@link accessListSchema}.
 * @param key - The param the list arrived in, for the refusal.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the unknown tags.
 */
export async function assertAccessListTags(
  db: DbHandle,
  projectId: number,
  list: string[],
  key: string,
): Promise<void> {
  const named = list.filter((entry) => entry !== ACCESS_EVERYONE);
  if (named.length === 0) return;
  const rows = await db
    .select({ name: tags.name })
    .from(tags)
    .where(
      and(
        eq(tags.projectId, projectId),
        inArray(sql`lower(btrim(${tags.name}))`, named),
      ),
    );
  const known = new Set(rows.map((r) => normalizeTagName(r.name)));
  const unknown = named.filter((entry) => !known.has(entry));
  if (unknown.length > 0) {
    throw new TypedError({
      message: `No tag named ${unknown.map((u) => `"${u}"`).join(", ")} in this project. Create the tag first, or use "${ACCESS_EVERYONE}" for every member.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key,
    });
  }
}

/** One object whose access lists name a tag. */
export interface AccessListReference {
  kind: string;
  id: number;
  label: string;
}

/**
 * Every object in a project whose `accessRead` or `accessWrite` names a tag.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param tagName - The tag name, compared normalized.
 * @returns The referencing objects, across every registered table.
 */
export async function findAccessListReferences(
  db: DbHandle,
  projectId: number,
  tagName: string,
): Promise<AccessListReference[]> {
  const target = normalizeTagName(tagName);
  const found: AccessListReference[] = [];
  for (const definition of accessListTables.values()) {
    for (const row of await loadLists(db, definition, projectId)) {
      if (
        row.accessRead.some((e) => normalizeTagName(e) === target) ||
        row.accessWrite.some((e) => normalizeTagName(e) === target) ||
        row.tagNames.some((e) => normalizeTagName(e) === target)
      ) {
        found.push({ kind: definition.kind, id: row.id, label: row.label });
      }
    }
  }
  return found;
}

/**
 * Rename a tag inside every access list that names it, so a rename changes no
 * one's access: `["finance"]` must keep meaning the people who hold that tag,
 * not nobody (and, the day someone recreates `finance`, whoever holds the new one).
 * @param tx - The transaction renaming the tag.
 * @param projectId - The project.
 * @param from - The old name.
 * @param to - The new name.
 * @returns The objects whose lists changed.
 */
export async function renameTagInAccessLists(
  tx: TxHandle,
  projectId: number,
  from: string,
  to: string,
): Promise<AccessListReference[]> {
  const source = normalizeTagName(from);
  const target = normalizeTagName(to);
  const rename = (list: string[]) => [
    ...new Set(list.map((e) => (normalizeTagName(e) === source ? target : e))),
  ];
  const changed: AccessListReference[] = [];
  for (const definition of accessListTables.values()) {
    for (const row of await loadLists(tx, definition, projectId)) {
      const names = [...row.accessRead, ...row.accessWrite, ...row.tagNames];
      if (!names.some((e) => normalizeTagName(e) === source)) continue;
      // Raw SQL because a registered table is known by its columns, not by the
      // property names Drizzle's `set` is keyed on. `SET` takes bare identifiers.
      const assignments = [
        sql`${sql.identifier(definition.accessRead.name)} = ${JSON.stringify(rename(row.accessRead))}::jsonb`,
        sql`${sql.identifier(definition.accessWrite.name)} = ${JSON.stringify(rename(row.accessWrite))}::jsonb`,
        ...(definition.tagColumns ?? []).map(
          (column) =>
            sql`${sql.identifier(column.name)} = CASE WHEN lower(btrim(${sql.identifier(column.name)})) = ${source} THEN ${target} ELSE ${sql.identifier(column.name)} END`,
        ),
      ];
      await tx.execute(
        sql`UPDATE ${definition.table} SET ${sql.join(assignments, sql`, `)} WHERE ${sql.identifier(definition.id.name)} = ${row.id}`,
      );
      changed.push({ kind: definition.kind, id: row.id, label: row.label });
    }
  }
  return changed;
}

/**
 * Read the lists of every row of one registered table in a project.
 * @param db - A database handle.
 * @param definition - The table.
 * @param projectId - The project.
 * @returns Each row's id, label, lists, and the tags its tag columns name.
 */
async function loadLists(
  db: DbHandle,
  definition: AccessListTable,
  projectId: number,
) {
  const tagColumns = definition.tagColumns ?? [];
  const rows = (await db
    .select({
      id: definition.id,
      label: definition.label,
      accessRead: definition.accessRead,
      accessWrite: definition.accessWrite,
      ...Object.fromEntries(tagColumns.map((c, i) => [`tag${i}`, c])),
    })
    .from(definition.table)
    .where(eq(definition.projectId, projectId))) as ({
    id: number;
    label: string;
    accessRead: string[];
    accessWrite: string[];
  } & Record<string, unknown>)[];
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    accessRead: row.accessRead,
    accessWrite: row.accessWrite,
    tagNames: tagColumns
      .map((_, i) => row[`tag${i}`])
      .filter((v): v is string => typeof v === "string" && v !== ""),
  }));
}
