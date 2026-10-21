/**
 * The CLI's side of the control socket: one JSON-RPC call per connection.
 * Every local command (`daemon status|stop|reload`, `doctor`, `upgrade`) goes
 * through {@link callDaemon}; a missing or silent socket is
 * {@link DaemonNotRunning}, which those commands turn into exit code 3.
 */
import { existsSync } from "node:fs";

/** What a command prints, and its exit code, when the daemon is not running. */
export const NOT_RUNNING_MESSAGE =
  'daemon is not running (start it with "hypotenuse daemon start")';

/** The exit code of a command that needs a daemon and found none. */
export const EXIT_NOT_RUNNING = 3;

/** The daemon is not there to answer. */
export class DaemonNotRunning extends Error {
  /**
   * @param socketPath - The socket that did not answer.
   */
  constructor(readonly socketPath: string) {
    super(NOT_RUNNING_MESSAGE);
    this.name = "DaemonNotRunning";
  }
}

/** The daemon answered with an error. */
export class DaemonRpcError extends Error {
  /**
   * @param code - The JSON-RPC code.
   * @param message - The daemon's message.
   */
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

/**
 * Call one method on the daemon.
 * @param socketPath - The control socket.
 * @param method - The method.
 * @param params - Its params.
 * @param timeoutMs - How long to wait for the answer.
 * @returns The result.
 * @throws {DaemonNotRunning} When nothing answers on the socket.
 * @throws {DaemonRpcError} When the daemon refuses.
 */
export async function callDaemon<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000,
): Promise<T> {
  if (!existsSync(socketPath)) throw new DaemonNotRunning(socketPath);
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let open: { terminate(): void } | null = null;
    // Whatever the outcome, the connection is closed: an open one would keep
    // the CLI's event loop, and so the process, alive.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      open?.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new DaemonNotRunning(socketPath))),
      timeoutMs,
    );
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
          socket.flush();
        },
        data(_socket, data) {
          buffer += data.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          finish(() => {
            try {
              const reply = JSON.parse(buffer.slice(0, newline)) as {
                result?: T;
                error?: { code: number; message: string };
              };
              if (reply.error)
                reject(
                  new DaemonRpcError(reply.error.code, reply.error.message),
                );
              else resolve(reply.result as T);
            } catch (error) {
              reject(error);
            }
          });
        },
        close() {
          finish(() => reject(new DaemonNotRunning(socketPath)));
        },
        error() {
          finish(() => reject(new DaemonNotRunning(socketPath)));
        },
        connectError() {
          finish(() => reject(new DaemonNotRunning(socketPath)));
        },
      },
    })
      .then((socket) => {
        open = socket;
        if (settled) socket.terminate();
      })
      .catch(() => finish(() => reject(new DaemonNotRunning(socketPath))));
  });
}

/**
 * Whether something answers `status` on a socket.
 * @param socketPath - The socket.
 * @param timeoutMs - How long to wait.
 * @returns True when the daemon answered.
 */
export async function socketAnswers(
  socketPath: string,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    await callDaemon(socketPath, "status", {}, timeoutMs);
    return true;
  } catch (error) {
    return error instanceof DaemonRpcError;
  }
}
