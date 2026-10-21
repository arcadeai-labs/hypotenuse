/**
 * Durations and sizes as a person writes them in the config file: a number and
 * a unit, `"45s"`, `"10m"`, `"2h"`, `"7d"`, `"500MB"`, `"2GB"`. Parsed to
 * milliseconds and bytes, and printed back in the same spelling so a
 * validation message quotes the value the way the file says it.
 */

/** Milliseconds per duration unit. */
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Bytes per size unit (powers of 1024, spelt the way people write them). */
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/** What a duration string looks like. */
export const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** What a size string looks like. */
export const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i;

/**
 * Parse a duration.
 * @param value - `"45s"`, `"10m"`, `"2h"`, `"7d"`, or `"500ms"`.
 * @returns Milliseconds.
 * @throws {Error} When the string is not a duration.
 */
export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration (use a number and a unit: 45s, 10m, 2h, 7d)`,
    );
  }
  return Math.round(
    Number(match[1]) * (DURATION_UNITS[match[2] as string] ?? 1),
  );
}

/**
 * Parse a size.
 * @param value - `"500MB"`, `"2GB"`.
 * @returns Bytes.
 * @throws {Error} When the string is not a size.
 */
export function parseSize(value: string): number {
  const match = SIZE_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a size (use a number and a unit: 500MB, 2GB)`,
    );
  }
  const unit = (match[2] as string).toUpperCase();
  return Math.round(Number(match[1]) * (SIZE_UNITS[unit] ?? 1));
}

/**
 * Print a duration in the largest unit that divides it exactly.
 * @param ms - Milliseconds.
 * @returns E.g. `"45m"`, `"90s"`, `"1500ms"`.
 */
export function formatDuration(ms: number): string {
  for (const unit of ["d", "h", "m", "s"] as const) {
    const size = DURATION_UNITS[unit] as number;
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/**
 * Print a size in the largest unit that keeps one decimal place readable.
 * @param bytes - Bytes.
 * @returns E.g. `"2GB"`, `"512MB"`.
 */
export function formatSize(bytes: number): string {
  for (const unit of ["TB", "GB", "MB", "KB"] as const) {
    const size = SIZE_UNITS[unit] as number;
    if (bytes >= size) {
      const n = bytes / size;
      return `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
    }
  }
  return `${bytes}B`;
}
