/**
 * The per-turn read cache: in the daemon, not the MCP process (which an agent
 * may restart), keyed by `(workItemId, tool, input)` for 60 s. Agents re-read
 * their issue constantly, and every re-read spends the integration's shared
 * 5,000-requests-an-hour budget. Any write through the same turn empties the
 * turn's entries, and so does the turn's end.
 */

/** How long a read is reused. */
export const READ_CACHE_TTL_MS = 60_000;

/** A cached result. */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A key for an input, stable whatever the order of its keys.
 * @param value - The input.
 * @returns Its canonical JSON.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Read results, per turn. */
export class ReadCache<T> {
  private readonly entries = new Map<number, Map<string, Entry<T>>>();

  /**
   * @param ttlMs - How long an entry lives.
   * @param now - The clock.
   */
  constructor(
    private readonly ttlMs = READ_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A cached result, if one is fresh.
   * @param workItemId - The turn.
   * @param tool - The tool.
   * @param input - Its input.
   * @returns The result, or undefined.
   */
  get(workItemId: number, tool: string, input: unknown): T | undefined {
    const key = `${tool}\0${stableJson(input)}`;
    const entry = this.entries.get(workItemId)?.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.get(workItemId)?.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Remember a result.
   * @param workItemId - The turn.
   * @param tool - The tool.
   * @param input - Its input.
   * @param value - The result.
   */
  set(workItemId: number, tool: string, input: unknown, value: T): void {
    let turn = this.entries.get(workItemId);
    if (!turn) {
      turn = new Map();
      this.entries.set(workItemId, turn);
    }
    turn.set(`${tool}\0${stableJson(input)}`, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /**
   * Forget a turn's results: after a write, and at the turn's end.
   * @param workItemId - The turn.
   */
  invalidate(workItemId: number): void {
    this.entries.delete(workItemId);
  }
}
