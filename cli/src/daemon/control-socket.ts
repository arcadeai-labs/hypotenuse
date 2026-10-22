/**
 * The control socket: newline-delimited JSON-RPC 2.0 on a Unix domain socket
 * in the state directory. The file is `0600`, and that mode **is** the
 * authentication — only the user who runs the daemon can connect.
 *
 * | Method | Used by |
 * |---|---|
 * | `status` | `daemon status`, `doctor` |
 * | `agents.list`, `agents.kill` | `agents list|kill` |
 * | `worktrees.list`, `worktrees.cleanup` | `worktrees list|cleanup` |
 * | `drain` | `daemon stop`, `upgrade` |
 * | `reload` | `daemon reload`, `SIGHUP` |
 * | `restart` | `upgrade` |
 * | `mcp.hello`, `mcp.call` | `hypotenuse mcp`, the agent's tool server (`daemon/mcp-broker.ts`) |
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket, UnixSocketListener } from "bun";

/** A JSON-RPC error code: the method does not exist. */
export const METHOD_NOT_FOUND = -32601;

/** A JSON-RPC error code: the params are wrong. */
export const INVALID_PARAMS = -32602;

/** A JSON-RPC error code: the method failed. */
export const INTERNAL_ERROR = -32603;

/** A method handler. Throw a {@link RpcError} for a typed refusal. */
export type RpcHandler = (
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** A refusal with a JSON-RPC code. */
export class RpcError extends Error {
  /**
   * @param code - The JSON-RPC error code.
   * @param message - What went wrong.
   */
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Per-connection read buffer. */
interface ConnectionData {
  buffer: string;
}

/** The daemon's control socket server. */
export class ControlServer {
  private listener: UnixSocketListener<ConnectionData> | null = null;

  /**
   * @param path - The socket file.
   * @param handlers - The methods, by name.
   * @param onError - Called with a handler's unexpected failure.
   */
  constructor(
    readonly path: string,
    private readonly handlers: Record<string, RpcHandler>,
    private readonly onError: (
      method: string,
      error: unknown,
    ) => void = () => {},
  ) {}

  /**
   * Bind the socket, replacing a stale file (the caller holds the machine
   * lock, so a file here belongs to no live daemon), at mode `0600`.
   */
  listen(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) rmSync(this.path, { force: true });
    const previous = process.umask(0o177);
    try {
      this.listener = Bun.listen<ConnectionData>({
        unix: this.path,
        socket: {
          open: (socket) => {
            socket.data = { buffer: "" };
          },
          data: (socket, data) => this.onData(socket, data),
          error: () => {},
        },
      });
    } finally {
      process.umask(previous);
    }
    chmodSync(this.path, 0o600);
  }

  /** Stop listening and remove the socket file. */
  close(): void {
    this.listener?.stop(true);
    this.listener = null;
    rmSync(this.path, { force: true });
  }

  /**
   * Split the stream into lines and answer each request.
   * @param socket - The connection.
   * @param data - Bytes read.
   */
  private onData(socket: Socket<ConnectionData>, data: Buffer): void {
    socket.data.buffer += data.toString("utf8");
    let newline = socket.data.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = socket.data.buffer.slice(0, newline).trim();
      socket.data.buffer = socket.data.buffer.slice(newline + 1);
      if (line) void this.answer(socket, line);
      newline = socket.data.buffer.indexOf("\n");
    }
  }

  /**
   * Answer one request line.
   * @param socket - The connection.
   * @param line - The JSON-RPC request.
   */
  private async answer(
    socket: Socket<ConnectionData>,
    line: string,
  ): Promise<void> {
    let id: unknown = null;
    let reply: Record<string, unknown>;
    try {
      const request = JSON.parse(line) as {
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      id = request.id ?? null;
      const method = typeof request.method === "string" ? request.method : "";
      const handler = Object.hasOwn(this.handlers, method)
        ? this.handlers[method]
        : undefined;
      if (!handler)
        throw new RpcError(METHOD_NOT_FOUND, `unknown method "${method}"`);
      const params =
        request.params && typeof request.params === "object"
          ? (request.params as Record<string, unknown>)
          : {};
      try {
        reply = { jsonrpc: "2.0", id, result: (await handler(params)) ?? null };
      } catch (error) {
        if (!(error instanceof RpcError)) this.onError(method, error);
        throw error;
      }
    } catch (error) {
      reply = {
        jsonrpc: "2.0",
        id,
        error: {
          code:
            error instanceof RpcError
              ? error.code
              : error instanceof SyntaxError
                ? -32700
                : INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    try {
      socket.write(`${JSON.stringify(reply)}\n`);
      socket.flush();
    } catch {
      // The client went away.
    }
  }
}
