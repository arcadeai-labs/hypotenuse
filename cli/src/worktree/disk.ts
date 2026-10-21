/**
 * The disk guard: how much space is free on the volume a path is on, from
 * `statfs` (injectable, so tests can run out of disk on demand).
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

/** What the guard reads of `statfs`. */
export interface FsStats {
  bavail: number | bigint;
  bsize: number | bigint;
}

/** Reads `statfs` for a path. */
export type StatFs = (path: string) => FsStats;

/**
 * Bytes available to this user on the volume of a path (its nearest existing
 * ancestor, since the worktree root may not exist yet).
 * @param path - The path.
 * @param statfs - The `statfs` to use.
 * @returns Bytes free, or null when it cannot be read.
 */
export function freeBytes(
  path: string,
  statfs: StatFs = statfsSync as unknown as StatFs,
): number | null {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const stats = statfs(current);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * A byte count the way the config spells sizes: `1.4GB`, `512MB`.
 * @param bytes - The count.
 * @returns The text.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${text}${units[unit]}`;
}
