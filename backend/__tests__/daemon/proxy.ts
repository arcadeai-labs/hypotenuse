import type { Server, ServerWebSocket } from "bun";

/**
 * A small HTTP + WebSocket proxy in front of the booted server, so a daemon
 * test can make the server vanish (`down()`) and come back (`up()`) without
 * stopping the server the rest of the file uses, and can see every request a
 * daemon makes. Not a mock: every request it passes reaches the real server.
 */

/** One request seen by the proxy. */
export interface SeenRequest {
  method: string;
  path: string;
  authorization: string | null;
  at: number;
}

/** Per-socket state: the upstream connection and frames waiting for it. */
interface Pipe {
  upstream: WebSocket;
  pending: string[];
  cookie: string | null;
}

/** The proxy. */
export class ServerProxy {
  readonly seen: SeenRequest[] = [];
  private server: Server<Pipe> | null = null;
  private port = 0;
  private readonly sockets = new Set<ServerWebSocket<Pipe>>();

  /**
   * @param target - The real server's origin.
   */
  constructor(readonly target: string) {}

  /** The proxy's origin. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }

  /** Start (or restart, on the same port) forwarding. */
  up(): void {
    const target = this.target;
    this.server = Bun.serve<Pipe>({
      port: this.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        this.seen.push({
          method: req.method,
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          at: Date.now(),
        });
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const ok = server.upgrade(req, {
            data: {
              upstream: null as unknown as WebSocket,
              pending: [],
              cookie: req.headers.get("cookie"),
            },
          });
          return ok
            ? undefined
            : new Response("upgrade failed", { status: 400 });
        }
        const headers = new Headers(req.headers);
        headers.delete("host");
        const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
          redirect: "manual",
        });
        // fetch() already decoded the body; its length and encoding no longer apply.
        const answer = new Headers(upstream.headers);
        answer.delete("content-encoding");
        answer.delete("content-length");
        return new Response(await upstream.arrayBuffer(), {
          status: upstream.status,
          headers: answer,
        });
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
          const upstream = new WebSocket(target.replace(/^http/, "ws"), {
            headers: ws.data.cookie ? { Cookie: ws.data.cookie } : {},
          } as unknown as string[]);
          ws.data.upstream = upstream;
          upstream.addEventListener("open", () => {
            for (const frame of ws.data.pending.splice(0)) upstream.send(frame);
          });
          upstream.addEventListener("message", (event) =>
            ws.send(String(event.data)),
          );
          upstream.addEventListener("close", () => ws.close());
        },
        message: (ws, message) => {
          const frame = String(message);
          if (ws.data.upstream.readyState === WebSocket.OPEN)
            ws.data.upstream.send(frame);
          else ws.data.pending.push(frame);
        },
        close: (ws) => {
          this.sockets.delete(ws);
          ws.data.upstream?.close();
        },
      },
    });
    this.port = this.server.port ?? 0;
  }

  /** Refuse every connection, as a server that went away would. */
  down(): void {
    for (const ws of this.sockets) ws.close(1011, "proxy down");
    this.sockets.clear();
    this.server?.stop(true);
    this.server = null;
  }

  /**
   * Requests seen since a moment, optionally carrying a token.
   * @param since - Epoch ms.
   * @param token - Only requests with this bearer token.
   * @returns The requests.
   */
  since(since: number, token?: string): SeenRequest[] {
    return this.seen.filter(
      (r) => r.at >= since && (!token || r.authorization === `Bearer ${token}`),
    );
  }
}
