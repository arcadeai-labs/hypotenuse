/**
 * Add one CLI usage report to a running total, keeping the CLI's own spelling.
 *
 * **A session (and a supervisor retry) reports usage once per spawn, and the
 * run column holds one object.** Replacing with the newest report claims the
 * last spawn's tokens for the whole run. Summed key-wise in the reporting
 * CLI's spelling rather than normalized first, so fields we do not understand
 * today are still kept and the display summary can still tell whether cached
 * input is part of the input count by which fields are present.
 *
 * Non-numeric fields — a model name, a service tier — are not quantities and
 * take the newest report's value. Nested objects are summed the same way, so
 * `input_tokens_details.cached_tokens` accumulates instead of being replaced.
 * @param previous - What has been accumulated so far, if anything.
 * @param next - The spawn just reported, if it sent usage.
 * @returns The total, or `null` when neither side had anything to say.
 */
export function accumulateRunUsage(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!next) return previous ?? null;
  if (!previous) return next;

  const total: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const carried = total[key];
    if (typeof value === "number" && typeof carried === "number") {
      total[key] = value + carried;
    } else if (isPlainObject(value) && isPlainObject(carried)) {
      total[key] = accumulateRunUsage(carried, value);
    } else {
      total[key] = value;
    }
  }
  return total;
}

/**
 * Whether a value is a JSON object rather than an array, a null, or a scalar.
 * @param value - Anything out of a parsed CLI report.
 * @returns True when its entries can be summed key-wise.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
