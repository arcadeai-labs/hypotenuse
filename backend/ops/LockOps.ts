import { api } from "keryx";
import { runRedisScript } from "./RedisScriptOps";

/**
 * A short Redis lease that one process holds while it works on something no
 * other process may work on at the same time — one session's outbox, say.
 *
 * A lease and not a row lock, because the work it guards is an HTTP call to
 * Linear, and holding a Postgres transaction open across that would block
 * everything else that writes the row for as long as Linear takes to answer.
 * The TTL is the crash story: a holder that dies stops renewing nothing, and
 * the lease simply lapses.
 */

/**
 * Take a lease if nobody holds it.
 * @param key - The Redis key naming the thing guarded.
 * @param ttlMs - How long the lease lasts if it is never released.
 * @returns The holder's token, needed to release it, or null when held.
 */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const taken = await api.redis.redis.set(key, token, "PX", ttlMs, "NX");
  return taken === "OK" ? token : null;
}

/**
 * Give a lease back, only if it is still this holder's.
 * @param key - The Redis key.
 * @param token - What {@link acquireLock} returned.
 * @returns True when released; false when it had lapsed and been retaken.
 */
export async function releaseLock(
  key: string,
  token: string,
): Promise<boolean> {
  return Number(await runRedisScript("release-lock", [key], [token])) === 1;
}
