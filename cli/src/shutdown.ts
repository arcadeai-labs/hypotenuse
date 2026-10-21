/**
 * Signal-safe shutdown, from mcpx. Anything that must be closed on the way out
 * — a loopback listener, the daemon and its turns — registers a
 * {@link Closeable}; a signal closes them all, bounded by a hard timeout (8
 * seconds unless the daemon raises it to cover its drain), and exits with the
 * conventional code (SIGINT 130, SIGTERM 143, SIGHUP 129). A process may take
 * a signal over instead: the daemon makes SIGHUP a config reload.
 */
import { logger } from "./output/logger";

/** Something to close on shutdown. */
export interface Closeable {
  close(): Promise<void>;
}

/** Thrown to exit with a specific code through the normal shutdown path. */
export class ExitError extends Error {
  /**
   * @param code - The exit code.
   * @param message - Optional detail.
   */
  constructor(
    readonly code: number,
    message?: string,
  ) {
    super(message);
    this.name = "ExitError";
  }
}

const registry = new Set<Closeable>();
const overrides = new Map<NodeJS.Signals, () => void>();
let shuttingDown = false;
let installed = false;
let hardTimeoutMs = 8000;

/**
 * Raise (or lower) how long closing may take before the process exits anyway.
 * @param ms - The bound.
 */
export function setHardTimeout(ms: number): void {
  hardTimeoutMs = ms;
}

/**
 * Handle a signal instead of shutting down on it.
 * @param signal - The signal (the daemon takes SIGHUP for reload).
 * @param handler - What to do.
 */
export function onSignal(signal: NodeJS.Signals, handler: () => void): void {
  overrides.set(signal, handler);
}

/**
 * Close everything registered and exit, as a signal would.
 * @param exitCode - The code to exit with.
 * @returns Never; the process exits.
 */
export function shutdown(exitCode: number): Promise<never> {
  return runShutdown(exitCode);
}

/**
 * Register something to close on shutdown.
 * @param c - The closeable.
 */
export function register(c: Closeable): void {
  registry.add(c);
}

/**
 * Stop tracking something that closed on its own.
 * @param c - The closeable.
 */
export function unregister(c: Closeable): void {
  registry.delete(c);
}

/**
 * Close everything registered, then exit. A second signal exits at once.
 * @param exitCode - The code to exit with.
 */
async function runShutdown(exitCode: number): Promise<never> {
  if (shuttingDown) process.exit(exitCode);
  shuttingDown = true;
  const closeAll = Promise.allSettled([...registry].map((c) => c.close()));
  await Promise.race([
    closeAll,
    new Promise<void>((resolve) => setTimeout(resolve, hardTimeoutMs).unref()),
  ]);
  process.exit(exitCode);
}

/** Install the signal and last-resort error handlers, once. */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  const on = (signal: NodeJS.Signals, code: number) =>
    process.on(signal, () => {
      const override = overrides.get(signal);
      if (override) override();
      else void runShutdown(code);
    });
  on("SIGINT", 130);
  on("SIGTERM", 143);
  on("SIGHUP", 129);
  process.on("uncaughtException", (err) => {
    logger.error(`uncaught exception: ${err?.stack ?? String(err)}`);
    void runShutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    const detail =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
    logger.error(`unhandled rejection: ${detail}`);
    void runShutdown(1);
  });
}
