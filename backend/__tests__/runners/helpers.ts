import {
  type HeartbeatRequest,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { type Runner, runners } from "../../schema/runners";
import { authHeaders, type TestUser } from "../setup";

/**
 * Runner fixtures: registering through the real `runner:register`, and
 * speaking the daemon's half of the wire protocol the way a daemon would — a
 * scripted HTTP and WebSocket client, no daemon process.
 */

/** A registered runner and its one-time token. */
export interface TestRunner {
  id: number;
  name: string;
  token: string;
}

/**
 * Register a runner as a user, over HTTP.
 * @param url - The server.
 * @param user - Who registers it (its owner).
 * @param projectId - The project.
 * @param name - Its name.
 * @param replace - Revoke an existing runner of that name first.
 * @returns The runner's id, name, and token.
 * @throws {Error} When registration is not a 200.
 */
export async function registerRunner(
  url: string,
  user: TestUser,
  projectId: number,
  name: string,
  replace = false,
): Promise<TestRunner> {
  const res = await fetch(`${url}/api/runner`, {
    method: "PUT",
    headers: authHeaders(user.sessionId),
    body: JSON.stringify({ projectId, name, replace }),
  });
  const body = (await res.json()) as {
    runner?: { id: number; name: string };
    token?: string;
  };
  if (res.status !== 200 || !body.runner || !body.token) {
    throw new Error(`runner:register failed: ${JSON.stringify(body)}`);
  }
  return { id: body.runner.id, name: body.runner.name, token: body.token };
}

/**
 * The headers a daemon sends.
 * @param token - The runner token.
 * @param protocol - The protocol version header, or `null` to omit it.
 * @returns Headers for `fetch()`.
 */
export function daemonHeaders(
  token: string,
  protocol: string | null = String(PROTOCOL_VERSION),
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(protocol === null ? {} : { [PROTOCOL_HEADER]: protocol }),
  };
}

/**
 * A valid heartbeat body, with overrides.
 * @param over - Fields to replace.
 * @returns The body.
 */
export function heartbeatBody(
  over: Partial<HeartbeatRequest> = {},
): HeartbeatRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.4.0",
    platform: "darwin-arm64",
    hostname: "test-host",
    draining: false,
    machineId: `sha256:${crypto.randomUUID().replace(/-/g, "")}`,
    limits: { maxParallelJobs: 2 },
    active: [],
    capabilities: {
      roles: ["worker"],
      agents: [{ id: "claude", preset: "claude", available: true }],
      repositories: [
        {
          name: "web",
          remote: "git@github.com:acme/web.git",
          baseBranch: "main",
        },
      ],
      subscriptions: { teams: ["ENG"], projects: [], labels: ["Frontend"] },
    },
    ...over,
  };
}

/**
 * Post a heartbeat.
 * @param url - The server.
 * @param token - The runner token.
 * @param body - The heartbeat.
 * @returns The raw response.
 */
export function heartbeat(
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${url}/api/daemon/heartbeat`, {
    method: "POST",
    headers: daemonHeaders(token),
    body: JSON.stringify(body),
  });
}

/**
 * Call `daemon:connect`.
 * @param url - The server.
 * @param token - The runner token.
 * @param machineId - The machine id to report.
 * @returns The raw response.
 */
export function connect(
  url: string,
  token: string,
  machineId: string,
): Promise<Response> {
  return fetch(`${url}/api/daemon/connect`, {
    method: "POST",
    headers: daemonHeaders(token),
    body: JSON.stringify({ machineId }),
  });
}

/**
 * The session id a response's `Set-Cookie` carries.
 * @param res - The response.
 * @returns The `__session` value.
 * @throws {Error} When there is none.
 */
export function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${config.session.cookieName}=([^;]+)`).exec(header);
  if (!match?.[1]) throw new Error(`no session cookie in: ${header}`);
  return match[1];
}

/**
 * The runner's row, read directly.
 * @param id - The runner.
 * @returns The row.
 */
export async function runnerRow(id: number): Promise<Runner> {
  const [row] = await api.db.db
    .select()
    .from(runners)
    .where(eq(runners.id, id))
    .limit(1);
  if (!row) throw new Error(`no runner ${id}`);
  return row;
}

/** A WebSocket with its parsed message log. */
export interface TestSocket {
  socket: WebSocket;
  messages: Record<string, unknown>[];
}

/**
 * Open a WebSocket presenting a session cookie.
 * @param url - The server.
 * @param session - The session id, if any.
 * @returns The open socket and its log.
 */
export async function openSocket(
  url: string,
  session?: string,
): Promise<TestSocket> {
  const socket = new WebSocket(url.replace(/^http/, "ws"), {
    headers: session
      ? { Cookie: `${config.session.cookieName}=${session}` }
      : {},
  });
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  return { socket, messages };
}

/**
 * Subscribe and wait for the answer.
 * @param s - The socket.
 * @param channel - The channel.
 * @returns Whether it was accepted, and the refusal if not.
 */
export async function subscribe(
  s: TestSocket,
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  const messageId = crypto.randomUUID();
  s.socket.send(
    JSON.stringify({ messageType: "subscribe", channel, messageId }),
  );
  const deadline = Date.now() + 5_000;
  for (;;) {
    for (const m of s.messages) {
      if (m.messageId !== messageId) continue;
      if ((m.subscribed as { channel?: string } | undefined)?.channel) {
        return { ok: true };
      }
      if (m.error) {
        return {
          ok: false,
          error: (m.error as { message?: string }).message,
        };
      }
    }
    if (Date.now() > deadline) return { ok: false, error: "no answer" };
    await Bun.sleep(20);
  }
}

/**
 * The `event`s of the frames published to a channel and delivered so far.
 * @param s - The socket.
 * @param channel - The channel.
 * @returns The events, in order.
 */
export function frames(s: TestSocket, channel: string): string[] {
  return s.messages.flatMap((raw) => {
    const m = raw.message as { channel?: string; message?: string } | undefined;
    if (m?.channel !== channel || typeof m.message !== "string") return [];
    const payload = JSON.parse(m.message) as { event?: string };
    return payload.event ? [payload.event] : [];
  });
}

/**
 * Wait until a predicate holds, bounded.
 * @param check - The predicate.
 * @param timeoutMs - How long to wait.
 * @returns Whether it held.
 */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return check();
}
