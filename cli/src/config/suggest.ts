/**
 * "Did you mean" for config names: the Damerau–Levenshtein distance (optimal
 * string alignment), and the nearest candidate within two edits.
 */

/**
 * The edit distance between two strings, counting a swap of neighbours as one.
 * @param a - One string.
 * @param b - The other.
 * @returns Insertions, deletions, substitutions, and transpositions needed.
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(
          row[j] as number,
          ((d[i - 2] as number[])[j - 2] as number) + 1,
        );
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * The candidate nearest a name, if one is within two edits.
 * @param name - What was written.
 * @param candidates - What it could have meant.
 * @returns The nearest candidate (ties go to the first), or undefined.
 */
export function suggest(
  name: string,
  candidates: Iterable<string>,
): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The " (did you mean …?)" suffix for a message.
 * @param name - What was written.
 * @param candidates - What it could have meant.
 * @returns The suffix, or an empty string.
 */
export function didYouMean(name: string, candidates: Iterable<string>): string {
  const near = suggest(name, candidates);
  return near ? ` (did you mean "${near}"?)` : "";
}
