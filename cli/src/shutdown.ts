/**
 * Signal-safe shutdown, from mcpx. Anything that must be closed on the way out
 * — a loopback listener now, the daemon's agent processes later — registers a
 * {@link Closeable}; a signal closes them all, bounded by an 8-second hard
 * timeout, and exits with the conventional code (SIGINT 130, SIGTERM 143,
 * SIGHUP 129).
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
let shuttingDown = false;
let installed = false;
const HARD_TIMEOUT_MS = 8000;

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
    new Promise<void>((resolve) =>
      setTimeout(resolve, HARD_TIMEOUT_MS).unref(),
    ),
  ]);
  process.exit(exitCode);
}

/** Install the signal and last-resort error handlers, once. */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", () => void runShutdown(130));
  process.on("SIGTERM", () => void runShutdown(143));
  process.on("SIGHUP", () => void runShutdown(129));
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
