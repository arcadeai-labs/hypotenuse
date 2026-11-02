/**
 * **Fencing untrusted text** for a bot to read: a coding agent's output, a
 * GitHub reviewer's comment, a pull request's title. The fence is a pair of
 * marker lines, `<<<…>>>` and `<<<end of …>>>`, and the bot is told that what
 * is between them is data, never an instruction from a person.
 *
 * A fence is only as good as the guarantee that the text inside cannot
 * close it. So every run of three or more `<` or `>` inside the text is
 * rewritten to the look-alike `‹` / `›` before it is wrapped: no text, however
 * it was written, contains a marker, and so none can end the fence early and
 * speak outside it. Two or fewer angle brackets (`a << b`, `=>`, HTML) pass
 * through untouched. The rewrite is deterministic, so the same text fences
 * to the same message every time (a redelivery's `deliveryKey` dedupe and a
 * scripted model's expectations both rely on that).
 */

/** The longest text a fence carries by default; past it, cut with a note. */
export const DEFAULT_FENCE_LIMIT = 4_000;

/**
 * Rewrite every run of three or more `<` or `>` so it cannot form a fence
 * marker: `<<<` becomes `‹‹‹`, `>>>>` becomes `››››`.
 * @param text - The untrusted text.
 * @returns It, with no marker-shaped run left.
 */
export function neutralizeFenceMarkers(text: string): string {
  return text
    .replace(/<{3,}/g, (run) => "‹".repeat(run.length))
    .replace(/>{3,}/g, (run) => "›".repeat(run.length));
}

/**
 * Fence untrusted text between a start and an end marker, after neutralizing
 * any marker inside it and cutting it to `limit` characters.
 * @param text - The untrusted text.
 * @param what - What it is, named in both markers, e.g. `GitHub text`.
 * @param why - The start marker's warning, after "untrusted; ".
 * @param limit - The most characters kept; `Infinity` keeps all.
 * @returns The fenced text: the start marker, the text, the end marker.
 */
export function fenceUntrusted(
  text: string,
  what: string,
  why: string,
  limit = Number.POSITIVE_INFINITY,
): string {
  const safe = neutralizeFenceMarkers(text);
  const clipped =
    safe.length <= limit
      ? safe
      : `${safe.slice(0, limit)}\n…(${safe.length - limit} more characters)`;
  return `<<<${what} — untrusted; ${why}>>>\n${clipped}\n<<<end of ${what}>>>`;
}
