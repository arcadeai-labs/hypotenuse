/**
 * Reconnect backoff: 1 s × 2ⁿ, capped at 30 s, with full jitter — a delay
 * drawn uniformly from zero to the cap for this attempt, so a fleet that lost
 * the server at the same moment does not come back at the same moment.
 */
export class Backoff {
  private failures = 0;
  private healthySince: number | null = null;

  /**
   * @param baseMs - The first cap.
   * @param maxMs - The largest cap.
   * @param resetAfterMs - Healthy this long resets the count.
   * @param random - The jitter source, injectable for tests.
   * @param now - The clock, injectable for tests.
   */
  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 30_000,
    private readonly resetAfterMs = 60_000,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now,
  ) {}

  /** Failures since the last reset. */
  get attempts(): number {
    return this.failures;
  }

  /**
   * Record a failure.
   * @returns How long to wait before the next try.
   */
  fail(): number {
    this.healthySince = null;
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.failures);
    this.failures++;
    return Math.floor(this.random() * cap);
  }

  /** Record a success; the count resets once successes have lasted long enough. */
  succeed(): void {
    const now = this.now();
    this.healthySince ??= now;
    if (now - this.healthySince >= this.resetAfterMs) this.failures = 0;
  }

  /** Forget every failure. */
  reset(): void {
    this.failures = 0;
    this.healthySince = null;
  }
}
