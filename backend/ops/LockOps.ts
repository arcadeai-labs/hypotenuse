import { randomUUID } from "node:crypto";
import { api } from "keryx";
import { runRedisScript } from "./RedisScriptOps";

/**
 * Redis leases: a key set with `NX` and an expiry, holding a random token,
 * released only by its holder (`release-lock.lua`), so a holder that outlived
 * its lease never frees a successor's. A lease is an accelerant's guard, not
 * the source of truth: a lost one expires on its own.
 */

/** A lease this process holds. */
export interface Lease {
  key: string;
  token: string;
}

/**
 * Try to take a lease.
 * @param key - The lock key.
 * @param ttlMs - How long it lasts unless released.
 * @returns The lease, or `null` when someone else holds it.
 */
export async function acquireLease(
  key: string,
  ttlMs: number,
): Promise<Lease | null> {
  const token = randomUUID();
  const ok = await api.redis.redis.set(key, token, "PX", ttlMs, "NX");
  return ok === "OK" ? { key, token } : null;
}

/**
 * Release a lease, if this holder still has it.
 * @param lease - The lease.
 * @returns Whether it was released.
 */
export async function releaseLease(lease: Lease): Promise<boolean> {
  const n = await runRedisScript("release-lock", [lease.key], [lease.token]);
  return Number(n) === 1;
}
