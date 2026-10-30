import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/mcp";
import type { Bot } from "../schema/bots";
import {
  type McpCatalogTool,
  type McpServer,
  mcpServers,
} from "../schema/mcp_servers";
import { refreshTokens, tokensExpiring } from "./McpOAuthOps";
import { openCredentials, poolKey, requestHeaders } from "./McpServerOps";
import { guardedFetch } from "./NetworkGuardOps";

/**
 * The MCP client pool: one `Client` per server, credential version, and set
 * of request headers, per process. Workers share nothing: the protocol's
 * session ids are an optimization, not state. Every connection goes through
 * the SSRF guard's fetch, so every connect re-checks the host's addresses.
 *
 * - **Timeouts.** A call gets the server's `timeoutMs`, or `MCP_CALL_TIMEOUT_MS`.
 * - **Eviction.** A client idle for `MCP_CLIENT_IDLE_MS` is closed by the
 *   initializer's sweep; a credential change retires the old clients, since
 *   their key names the old version; past `MCP_MAX_CLIENTS` the least recently
 *   used goes.
 * - **Retries.** A 401 refreshes an OAuth token once and retries once.
 *   Nothing else is retried: a tool call is not known to be idempotent.
 * - **Elicitation** is never declared, so a server cannot ask mid-call.
 */

/** One pooled client. */
interface Pooled {
  client: Client;
  serverId: number;
  credentialVersion: number;
  lastUsed: number;
}

/** Every open client, by {@link poolKey}. Insertion order is recency order. */
const pool = new Map<string, Pooled>();

/** Connections in progress, so two callers share one handshake. */
const connecting = new Map<string, Promise<Client>>();

/** A server answered 401: the credentials are wrong or expired. */
export class McpUnauthorized extends Error {}

/**
 * Whether an error is the transport's 401.
 * @param error - What a call threw.
 * @returns `true` for a 401.
 */
function isUnauthorized(error: unknown): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === 401) return true;
    if (e instanceof Error && /\b401\b|unauthori[sz]ed/i.test(e.message))
      return true;
  }
  return false;
}

/**
 * Open a client for a server, as a bot (or as a person's test, with no bot).
 * @param server - The server.
 * @param bot - The bot, or null.
 * @returns The client and its pool key.
 */
async function clientFor(
  server: McpServer,
  bot: Pick<Bot, "id" | "projectId" | "slug"> | null,
): Promise<{ client: Client; key: string }> {
  const headers = requestHeaders(server, bot, openCredentials(server));
  const key = poolKey(server, headers);
  const pooled = pool.get(key);
  if (pooled) {
    pool.delete(key);
    pooled.lastUsed = Date.now();
    pool.set(key, pooled);
    return { client: pooled.client, key };
  }
  let pending = connecting.get(key);
  if (!pending) {
    pending = connect(server, headers);
    connecting.set(key, pending);
  }
  try {
    const client = await pending;
    if (!pool.has(key)) {
      pool.set(key, {
        client,
        serverId: server.id,
        credentialVersion: server.credentialVersion,
        lastUsed: Date.now(),
      });
      await trim();
    }
    return { client, key };
  } finally {
    connecting.delete(key);
  }
}

/**
 * Connect a new client.
 * @param server - The server.
 * @param headers - Its request headers.
 * @returns The connected client.
 */
async function connect(
  server: McpServer,
  headers: Record<string, string>,
): Promise<Client> {
  const timeoutMs = Math.max(
    server.timeoutMs ?? config.mcp.callTimeoutMs,
    config.mcp.connectTimeoutMs,
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
    fetch: (input, init) =>
      guardedFetch(input as string | URL, init, { timeoutMs }),
  });
  const client = new Client(
    { name: "hypotenuse", version: "2.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: config.mcp.connectTimeoutMs });
  return client;
}

/**
 * Close the least recently used clients past the pool's size.
 */
async function trim(): Promise<void> {
  while (pool.size > config.mcp.maxClients) {
    const [oldest] = pool.keys();
    await close(oldest);
  }
}

/**
 * Close and forget one client.
 * @param key - Its pool key.
 */
async function close(key: string): Promise<void> {
  const pooled = pool.get(key);
  pool.delete(key);
  await pooled?.client.close().catch(() => {});
}

/**
 * Close the clients of a server built with credentials older than a version —
 * after its credentials or URL change — or every one, after it is deleted or
 * disabled.
 * @param serverId - The server.
 * @param currentVersion - Keep clients of this version; omit to close all.
 */
export async function retireServerClients(
  serverId: number,
  currentVersion?: number,
): Promise<void> {
  for (const [key, pooled] of [...pool.entries()]) {
    if (
      pooled.serverId === serverId &&
      (currentVersion === undefined ||
        pooled.credentialVersion < currentVersion)
    )
      await close(key);
  }
}

/**
 * Close every client idle longer than `MCP_CLIENT_IDLE_MS`.
 * @returns How many were closed.
 */
export async function closeIdleClients(): Promise<number> {
  const cutoff = Date.now() - config.mcp.idleMs;
  let closed = 0;
  for (const [key, pooled] of [...pool.entries()]) {
    if (pooled.lastUsed < cutoff) {
      await close(key);
      closed++;
    }
  }
  return closed;
}

/** Close every client (process shutdown). */
export async function closeAllClients(): Promise<void> {
  for (const key of [...pool.keys()]) await close(key);
}

/**
 * The pool's keys, for tests asserting a credential change retires a client.
 * @returns The keys.
 */
export function pooledKeys(): string[] {
  return [...pool.keys()];
}

/**
 * Run something with a server's client. An OAuth token about to expire is
 * refreshed first; a 401 refreshes once and retries once (OAuth), or marks the
 * server `needs_auth` / `error` and throws {@link McpUnauthorized}.
 * @param server - The server, as read.
 * @param bot - The bot, or null for a person's test.
 * @param fn - The work.
 * @returns What `fn` returns.
 */
export async function withClient<T>(
  server: McpServer,
  bot: Pick<Bot, "id" | "projectId" | "slug"> | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  let current = server;
  if (
    current.authMode === "oauth" &&
    tokensExpiring(openCredentials(current).oauthTokens)
  ) {
    current = await refreshTokens(current.id, current.credentialVersion);
  }
  for (let attempt = 0; ; attempt++) {
    let key: string | null = null;
    try {
      const opened = await clientFor(current, bot);
      key = opened.key;
      return await fn(opened.client);
    } catch (error) {
      if (key && !(error instanceof McpUnauthorized)) {
        // A failed client may hold a dead session; the next call reconnects.
        if (isUnauthorized(error) || isTransportFailure(error))
          await close(key);
      }
      if (!isUnauthorized(error)) throw error;
      if (current.authMode === "oauth" && attempt === 0) {
        current = await refreshTokens(current.id, current.credentialVersion);
        continue;
      }
      await api.db.db
        .update(mcpServers)
        .set({
          status: current.authMode === "oauth" ? "needs_auth" : "error",
          lastError: "The server refused the credentials (HTTP 401).",
        })
        .where(eq(mcpServers.id, current.id));
      throw new McpUnauthorized(
        `${current.name} refused Hypotenuse's credentials (HTTP 401). An admin must update them on the MCP servers page.`,
      );
    }
  }
}

/**
 * Whether an error means the connection, not the call, failed.
 * @param error - What a call threw.
 * @returns `true` for transport errors.
 */
function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Streamable HTTP error|fetch|socket|ECONN|closed|timed out|aborted/i.test(
    message,
  );
}

/**
 * List every tool a server offers, following pagination.
 * @param server - The server.
 * @returns The catalog.
 */
export async function listServerTools(
  server: McpServer,
): Promise<McpCatalogTool[]> {
  return withClient(server, null, async (client) => {
    const tools: McpCatalogTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: config.mcp.connectTimeoutMs,
      });
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 5_000);
    return tools;
  });
}

/** What one tool call returned, reduced to what a model reads. */
export interface McpCallOutput {
  isError: boolean;
  /** The text content parts, joined. */
  text: string;
  /** Structured content, when the server sent some. */
  structuredContent?: unknown;
  /** Non-text parts, described (an image's type and size, a resource's URI). */
  attachments?: { type: string; description: string }[];
}

/**
 * Call one tool as a bot.
 * @param server - The server.
 * @param bot - The bot.
 * @param tool - The tool's name on the server.
 * @param args - Its arguments.
 * @param signal - Aborts the call when the tick stops.
 * @returns The output.
 */
export async function callServerTool(
  server: McpServer,
  bot: Pick<Bot, "id" | "projectId" | "slug">,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallOutput> {
  const result = await withClient(server, bot, (client) =>
    client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: server.timeoutMs ?? config.mcp.callTimeoutMs,
      signal,
    }),
  );
  const content = (result.content ?? []) as {
    type: string;
    text?: string;
    mimeType?: string;
    data?: string;
    resource?: { uri?: string; text?: string };
    uri?: string;
  }[];
  const texts: string[] = [];
  const attachments: { type: string; description: string }[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part.type === "resource" && part.resource?.text) {
      texts.push(part.resource.text);
    } else {
      attachments.push({
        type: part.type,
        description:
          part.type === "image" || part.type === "audio"
            ? `${part.mimeType ?? part.type}, ${Math.round(((part.data?.length ?? 0) * 3) / 4)} bytes (not shown)`
            : (part.uri ?? part.resource?.uri ?? part.type),
      });
    }
  }
  return {
    isError: result.isError === true,
    text: texts.join("\n"),
    ...(result.structuredContent !== undefined && texts.length === 0
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
