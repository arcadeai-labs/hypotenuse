/**
 * Two locks. A per-repository mutex inside the daemon, because git's own
 * locks on `.git/worktrees` and `packed-refs` do not survive two concurrent
 * `worktree add`s gracefully. And, for `worktrees = "never"`, a lock file in
 * the clone's git directory (`hypotenuse.lock`, holding the pid and session)
 * that lets one session at a time work in a person's checkout.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Serializes work per key (a repository path). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` once every earlier holder of `key` is done.
   * @param key - The repository.
   * @param fn - The critical section.
   * @returns What `fn` returns.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** What a checkout lock file says. */
export interface CheckoutLock {
  pid: number;
  agentSessionId: number;
  at: number;
}

/**
 * Whether a process is alive.
 * @param pid - The process id.
 * @returns True when it exists.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read a checkout lock.
 * @param file - The lock file.
 * @returns Its contents, or null when absent or unreadable.
 */
export function readCheckoutLock(file: string): CheckoutLock | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CheckoutLock;
  } catch {
    return null;
  }
}

/**
 * Take a checkout lock for a session: free, stale (its process is gone), or
 * already this session's.
 * @param file - The lock file.
 * @param agentSessionId - The session.
 * @param pid - This process.
 * @returns Null when taken, else the lock that holds it.
 */
export function takeCheckoutLock(
  file: string,
  agentSessionId: number,
  pid = process.pid,
): CheckoutLock | null {
  const held = readCheckoutLock(file);
  if (held && held.agentSessionId !== agentSessionId && pidAlive(held.pid)) {
    return held;
  }
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      agentSessionId,
      at: Date.now(),
    } satisfies CheckoutLock),
    { mode: 0o600 },
  );
  return null;
}

/**
 * Release a checkout lock this session holds.
 * @param file - The lock file.
 * @param agentSessionId - The session.
 */
export function releaseCheckoutLock(
  file: string,
  agentSessionId: number,
): void {
  const held = readCheckoutLock(file);
  if (!held || held.agentSessionId === agentSessionId)
    rmSync(file, { force: true });
}
