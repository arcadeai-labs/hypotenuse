/**
 * Convert a display name into a URL-friendly slug: lowercased, every run of
 * non-alphanumerics collapsed to one hyphen, leading and trailing hyphens trimmed.
 * @param name - The human-readable name.
 * @param fallback - What an all-punctuation name becomes.
 * @returns A slug such as `"Evan's Team"` → `"evan-s-team"`.
 */
export function generateSlug(name: string, fallback = "project"): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || fallback
  );
}

/**
 * The first of `base`, `base-2`, `base-3`, … that `taken` does not contain.
 *
 * Callers read `taken` inside the transaction that inserts, and the unique index
 * behind the slug is the real guard: two concurrent creations of the same name
 * can both pick `base-2`, and the loser's insert fails rather than duplicating.
 * @param base - The slug derived from the name.
 * @param taken - Slugs already in use in the same namespace.
 * @returns A slug not in `taken`.
 */
export function firstFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** What an explicitly chosen slug must look like. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
