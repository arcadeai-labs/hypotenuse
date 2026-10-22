/**
 * Names: a session's branch (`<prefix>/<issue>-<slug>`), the slug of an issue
 * title, and the directory of an issue's worktree.
 */

/** The longest slug, cut on a word boundary. */
export const SLUG_MAX = 40;

/**
 * An issue title as a branch-safe slug: lowercased, ASCII-folded,
 * non-alphanumerics collapsed to `-`, at most {@link SLUG_MAX} characters,
 * cut on a word boundary when one is in reach.
 * @param title - The issue title.
 * @returns The slug, possibly empty.
 */
export function slugify(title: string | null | undefined): string {
  const folded = (title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .replace(/œ/gi, "oe")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (folded.length <= SLUG_MAX) return folded;
  const cut = folded.slice(0, SLUG_MAX + 1);
  const boundary = cut.lastIndexOf("-");
  return (
    boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, SLUG_MAX)
  ).replace(/-+$/, "");
}

/**
 * A session's branch: `hypotenuse/eng-123-fix-checkout-total-rounding`.
 * @param prefix - `repositories[].branch_prefix`.
 * @param identifier - The issue identifier, or null.
 * @param title - The issue title.
 * @param fallback - Used when there is no identifier (the session id).
 * @returns The branch name.
 */
export function branchName(
  prefix: string,
  identifier: string | null,
  title: string | null,
  fallback: string,
): string {
  const id = (identifier ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const slug = slugify(title);
  return `${prefix.replace(/\/+$/, "")}/${id}${slug ? `-${slug}` : ""}`;
}

/**
 * The name a numbered alternative gets: `name`, then `name-2`, `name-3`, ….
 * @param name - The base name.
 * @param n - 1 for the base name.
 * @returns The name.
 */
export function suffixed(name: string, n: number): string {
  return n <= 1 ? name : `${name}-${n}`;
}

/**
 * The directory name of an issue's worktree: the identifier as Linear writes
 * it (`ENG-123`), made filesystem-safe.
 * @param identifier - The issue identifier, or null.
 * @param fallback - Used when there is none (the session id).
 * @returns The name.
 */
export function issueDirectory(
  identifier: string | null,
  fallback: string,
): string {
  return (identifier ?? fallback).replace(/[^A-Za-z0-9._-]+/g, "-");
}
