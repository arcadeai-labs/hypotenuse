import { setMaxListeners } from "node:events";
import { api, CONNECTION_TYPE, Connection, type WebServer } from "keryx";
// Must be first among local imports: sets `api.rootDir` so the framework can
// auto-discover actions, initializers, and channels before any of them load.
import "../index";

// Each test file boots its own server; the shared event bus can exceed the
// default 10-listener warning threshold when many suites run.
setMaxListeners(999);

/** Generous lifecycle-hook timeout — `api.start()` connects to Postgres + Redis and runs migrations. */
export const HOOK_TIMEOUT = 30_000;

/**
 * Run an action in-process the way a Resque worker would.
 *
 * Clocks and their child jobs are task-only (no public HTTP route), so suites
 * drive them through {@link Connection.act} rather than `fetch`. Uses
 * `CONNECTION_TYPE.TASK` so middleware that keys off the transport sees the
 * same shape production does.
 * @param name - Registered action name.
 * @param params - Raw params, validated against the action's Zod inputs.
 * @returns The action's response body.
 * @throws The action's TypedError when it fails.
 */
export async function runAction<T = unknown>(
  name: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const connection = new Connection(CONNECTION_TYPE.TASK, `test:${name}`);
  try {
    const { response, error } = await connection.act(name, params);
    if (error) throw error;
    return response as T;
  } finally {
    connection.destroy();
  }
}

/** How long {@link drainTasks} waits for a queue to go quiet. */
const DRAIN_TIMEOUT = 10_000;

/**
 * Wait until a Resque queue is empty and no worker is still inside a job.
 *
 * A test that calls a background helper directly races the worker that calls
 * it too; draining first makes the suite the only caller. Bounded rather than
 * unbounded: a queue that never empties is a suite bug worth seeing as the
 * assertion that follows, not as a hung file.
 * @param queueName - The queue to wait on.
 */
export async function drainTasks(queueName = "default"): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT;
  while (Date.now() < deadline) {
    const queued = await api.resque.queue.length(queueName);
    const working = await api.resque.queue.allWorkingOn();
    const busy = Object.values(working).some(
      (entry) => typeof entry === "object" && entry !== null,
    );
    if (queued === 0 && !busy) return;
    await Bun.sleep(20);
  }
}

/**
 * Return the URL the web server actually bound to (with its resolved port).
 * Call after `api.start()` (tests use `WEB_SERVER_PORT_TEST=0` for a random
 * free port per file). A wildcard host is rewritten to loopback, because
 * `0.0.0.0` is an address to listen on, not one to connect to.
 * @returns The bound base URL, or an empty string if the web server isn't running.
 */
export function serverUrl(): string {
  const web = api.servers.servers.find((s) => s.name === "web") as
    | WebServer
    | undefined;
  return (web?.url || "").replace("://0.0.0.0:", "://127.0.0.1:");
}

/**
 * Clear every table, retrying the Postgres deadlock (`40P01`) and
 * lock-not-available (`55P03`) codes a still-draining previous file can cause,
 * so a green suite is not a function of scheduling.
 */
export async function retryClearDatabase(): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await api.db.clearDatabase();
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableClearDatabaseError(error)) {
        throw error;
      }
      await Bun.sleep(25 * attempt);
    }
  }
}

/**
 * Walk an error (and Drizzle's wrapped cause) for a retryable Postgres code.
 * @param error - What `clearDatabase` threw.
 * @returns Whether another attempt may succeed.
 */
function isRetryableClearDatabaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (code === "40P01" || code === "55P03") return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : null;
  }
  return false;
}

// ioredis can emit a late "Connection is closed." rejection during `api.stop()`
// teardown races; it is benign, so swallow only that specific case.
process.on("unhandledRejection", (reason: unknown) => {
  if (
    reason instanceof Error &&
    reason.message === "Connection is closed." &&
    reason.stack?.includes("ioredis")
  ) {
    return;
  }
  throw reason;
});
