import { api, config } from "keryx";
import type { ActivityPriority } from "../schema/agent_activities";
import { rateLimitKey } from "./LinearOps";
import { runRedisScript } from "./RedisScriptOps";

/**
 * The per-installation request budget the activity outbox spends before every
 * write to Linear (`backend/lua/linear-token-bucket.lua`).
 *
 * Linear allows an OAuth app 5,000 requests an hour per app user. The bucket
 * refills at that rate (`LINEAR_REQUESTS_PER_HOUR`), holds a burst of 60, and
 * keeps its last 10 tokens for acknowledgements and stop answers — the writes
 * whose lateness a person in Linear sees — so a session chattering through its
 * budget cannot delay another session's "Received.". Whatever Linear last
 * reported remaining (`recordRateLimit`'s hash) pulls the bucket down when it
 * is lower than ours: Linear's count is the one that will be enforced.
 */

/** The outcome of asking for a token. */
export interface BucketTake {
  /** True when a token was taken and the request may go. */
  granted: boolean;
  /** When not granted, how long until one would be, in ms. */
  waitMs: number;
}

/**
 * The Redis key of an installation's bucket.
 * @param installationId - The installation.
 * @returns `linear:bucket:<id>`.
 */
export function bucketKey(installationId: number): string {
  return `linear:bucket:${installationId}`;
}

/**
 * How many tokens must remain after a take at each priority. `ack` may empty
 * the bucket; `normal` leaves the reserve; `bulk` — ephemeral thoughts —
 * leaves twice the reserve, so chatter is the first thing to wait.
 * @param priority - The row's priority.
 * @returns The headroom in tokens.
 */
export function headroomFor(priority: ActivityPriority): number {
  const reserve = config.linear.bucketReserve;
  if (priority === "ack") return 0;
  if (priority === "bulk") return reserve * 2;
  return reserve;
}

/**
 * What Linear last said remains, if it still means anything: an observation
 * stops counting once Linear's window has reset (or, when Linear sent no reset
 * time, after an hour — the window's length). Without this, a bucket that
 * expired while idle would be recreated and pinned to a count from a window
 * that is long over.
 * @param remaining - `X-RateLimit-Requests-Remaining`, as recorded.
 * @param observedAt - When it was recorded, epoch ms.
 * @param resetAt - `X-RateLimit-Requests-Reset`, epoch ms.
 * @param now - The current time, epoch ms.
 * @returns `[remaining, observedAt]` for the script, or `[-1, 0]` for none.
 */
export function currentObservation(
  remaining: number | null,
  observedAt: number | null,
  resetAt: number | null,
  now: number,
): [number, number] {
  if (
    remaining === null ||
    observedAt === null ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(observedAt)
  ) {
    return [-1, 0];
  }
  const expires =
    resetAt !== null && Number.isFinite(resetAt)
      ? resetAt
      : observedAt + 60 * 60 * 1000;
  return now < expires ? [remaining, observedAt] : [-1, 0];
}

/**
 * Take one token from an installation's bucket.
 * @param installationId - The installation the request will run as.
 * @param priority - The outbound row's priority.
 * @param now - The current time, epoch ms.
 * @returns Whether a token was granted, and how long to wait if not.
 */
export async function takeLinearToken(
  installationId: number,
  priority: ActivityPriority,
  now = Date.now(),
): Promise<BucketTake> {
  const [remaining, observedAt, resetAt] = await api.redis.redis.hmget(
    rateLimitKey(installationId),
    "requestsRemaining",
    "observedAt",
    "requestsResetAt",
  );
  const observed = currentObservation(
    remaining === null ? null : Number(remaining),
    observedAt === null ? null : Number(observedAt),
    resetAt === null ? null : Number(resetAt),
    now,
  );
  const reply = (await runRedisScript(
    "linear-token-bucket",
    [bucketKey(installationId)],
    [
      now,
      config.linear.requestsPerHour,
      config.linear.bucketBurst,
      headroomFor(priority),
      observed[0],
      observed[1],
    ],
  )) as [number, number];
  return { granted: Number(reply[0]) === 1, waitMs: Number(reply[1]) };
}
