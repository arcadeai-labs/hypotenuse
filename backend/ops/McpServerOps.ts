import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ErrorType, secret, TypedError } from "keryx";
import { z } from "zod";
import type { Bot } from "../schema/bots";
import {
  MCP_AUTH_MODES,
  type McpCatalogTool,
  type McpOAuthClient,
  type McpOAuthTokens,
  type McpServer,
  mcpServers,
} from "../schema/mcp_servers";
import {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
  lastFourOf,
} from "./CryptoOps";
import type { DbHandle } from "./DbOps";
import { urlRefusal } from "./NetworkGuardOps";

/**
 * The MCP server registry: inputs, the serializer that keeps every credential
 * out of every answer, sealing and opening credentials, and the per-bot
 * header templates.
 */

/** The Zod input for a server's name: the slug a bot writes in `server/tool`. */
export const mcpServerNameInput = z
  .string()
  .trim()
  .min(1, "A server name is required")
  .max(64, "A server name is at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "A server name uses lowercase letters, digits, and dashes, and starts with a letter or digit",
  )
  .describe(
    "A short slug for this server, unique in the project, e.g. arcade or github. Bots name its tools as <name>/<tool>",
  );

/** The Zod input for a server's URL. */
export const mcpServerUrlInput = z
  .string()
  .trim()
  .max(2048)
  .url("The URL must be an absolute URL")
  .describe(
    "The server's Streamable HTTP endpoint, e.g. https://api.arcade.dev/mcp/my-gateway",
  );

/** The Zod input for how the server authenticates. */
export const mcpAuthModeInput = z
  .enum(MCP_AUTH_MODES)
  .describe(
    "none; headers (static headers, e.g. an API key and Arcade-User-ID); bearer (a token sent as Authorization: Bearer); or oauth (sign in through the server's authorization server)",
  );

/** The Zod input for static headers. */
export const mcpHeadersInput = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9-]+$/,
        "A header name uses letters, digits, and dashes",
      ),
    z.string().max(8192),
  )
  .describe(
    "Header names and values sent with every request, for authMode headers. A value may contain {{bot.slug}} or {{bot.identity}}, filled in per bot, so one gateway can keep each bot's tool authorizations apart. Stored encrypted; never returned",
  );

/** The Zod input for a per-call timeout. */
export const mcpTimeoutInput = z
  .number()
  .int()
  .min(1_000)
  .max(600_000)
  .describe("How long one tool call may take, in milliseconds (default 60000)");

/** The Zod input for a bearer token. */
export const bearerTokenInput = secret(
  z
    .string()
    .trim()
    .min(1)
    .max(8192)
    .describe(
      "The token sent as Authorization: Bearer, for authMode bearer. Stored encrypted; never returned",
    ),
);

/** The Zod input for an OAuth client id an admin registered by hand. */
export const oauthClientIdInput = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe(
    "For authMode oauth: a client id registered at the server's authorization server, when it does not offer dynamic registration",
  );

/** The Zod input for that client's secret. */
export const oauthClientSecretInput = secret(
  z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe(
      "That client's secret, if it has one. Stored encrypted; never returned",
    ),
);

/**
 * Refuse credentials that do not fit the auth mode.
 * @param authMode - The mode.
 * @param params - What was sent.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export function assertCredentialsFit(
  authMode: string,
  params: { headers?: Record<string, string>; bearerToken?: string },
): void {
  if (authMode === "headers" && !params.headers) {
    throw new TypedError({
      message: "authMode headers needs headers.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "headers",
    });
  }
  if (authMode === "bearer" && !params.bearerToken) {
    throw new TypedError({
      message: "authMode bearer needs a bearerToken.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "bearerToken",
    });
  }
}

/** The placeholders a header value may contain. */
export const HEADER_PLACEHOLDERS = [
  "{{bot.slug}}",
  "{{bot.identity}}",
] as const;

/**
 * A bot's stable identity at a gateway: the same across renames of its slug.
 * @param bot - The bot.
 * @returns `hypotenuse-<projectId>-<botId>`.
 */
export function botIdentity(bot: Pick<Bot, "id" | "projectId">): string {
  return `hypotenuse-${bot.projectId}-${bot.id}`;
}

/**
 * Fill a header value's placeholders for a bot. With no bot (a person testing
 * the connection), they become the testing person's view: `test`.
 * @param value - The stored value.
 * @param bot - The bot the request is for, if any.
 * @returns The value to send.
 */
export function fillHeader(
  value: string,
  bot: Pick<Bot, "id" | "projectId" | "slug"> | null,
): string {
  return value
    .replaceAll("{{bot.slug}}", bot ? bot.slug : "test")
    .replaceAll("{{bot.identity}}", bot ? botIdentity(bot) : "hypotenuse-test");
}

/**
 * Shape a server for any answer. There is no field a credential fits in:
 * `headerNames` lists names, never values, and `lastFour` is the only part of
 * a bearer token any answer carries.
 * @param row - The server row.
 * @returns The serialized server.
 */
export function serializeMcpServer(row: McpServer) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    url: row.url,
    transport: row.transport,
    authMode: row.authMode,
    headerNames: row.headerNames,
    lastFour: row.lastFour,
    signedIn: row.authMode === "oauth" ? row.oauthTokens !== null : null,
    credentialVersion: row.credentialVersion,
    enabled: row.enabled,
    timeoutMs: row.timeoutMs,
    status: row.status,
    lastError: row.lastError,
    toolCount: row.toolsCache.length,
    toolsRefreshedAt: row.toolsRefreshedAt?.getTime() ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Shape one catalog tool for an answer or a model.
 * @param server - The server's name.
 * @param tool - The cached tool.
 * @returns The tool, named `server/tool`.
 */
export function serializeCatalogTool(server: string, tool: McpCatalogTool) {
  return {
    name: `${server}/${tool.name}`,
    server,
    tool: tool.name,
    title: tool.title ?? tool.annotations?.title ?? null,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  };
}

/** What a server's credentials are, opened. */
export interface OpenedCredentials {
  headers: Record<string, string>;
  bearer: string | null;
  oauthClient: McpOAuthClient | null;
  oauthTokens: McpOAuthTokens | null;
}

/**
 * Seal the static credentials of a server for its row.
 * @param authMode - How it authenticates.
 * @param input - The headers or bearer token sent.
 * @returns The columns to write.
 */
export function sealCredentials(
  authMode: McpServer["authMode"],
  input: { headers?: Record<string, string>; bearerToken?: string },
): Pick<McpServer, "credentials" | "headerNames" | "lastFour"> {
  if (authMode === "headers") {
    const headers = input.headers ?? {};
    return {
      credentials: encryptSecret(JSON.stringify(headers)),
      headerNames: Object.keys(headers).sort(),
      lastFour: null,
    };
  }
  if (authMode === "bearer" && input.bearerToken) {
    return {
      credentials: encryptSecret(input.bearerToken),
      headerNames: [],
      lastFour: lastFourOf(input.bearerToken),
    };
  }
  return { credentials: null, headerNames: [], lastFour: null };
}

/**
 * Open a sealed JSON value.
 * @param sealed - The sealed column, or null.
 * @returns The value, or null.
 */
function openJson<T>(sealed: EncryptedSecret | null): T | null {
  return sealed ? (JSON.parse(decryptSecret(sealed)) as T) : null;
}

/**
 * Open every credential a server holds. Only the process making a request
 * calls this, at the request.
 * @param row - The server row.
 * @returns The opened credentials.
 */
export function openCredentials(row: McpServer): OpenedCredentials {
  return {
    headers:
      row.authMode === "headers"
        ? (openJson<Record<string, string>>(row.credentials) ?? {})
        : {},
    bearer:
      row.authMode === "bearer" && row.credentials
        ? decryptSecret(row.credentials)
        : null,
    oauthClient: openJson<McpOAuthClient>(row.oauthClient),
    oauthTokens: openJson<McpOAuthTokens>(row.oauthTokens),
  };
}

/**
 * Seal an OAuth client or token set.
 * @param value - The value.
 * @returns The sealed column.
 */
export function sealJson(value: unknown): EncryptedSecret {
  return encryptSecret(JSON.stringify(value));
}

/**
 * The headers a request to a server carries for a bot.
 * @param row - The server.
 * @param bot - The bot, or null for a person's test.
 * @param opened - Its opened credentials (opened once by the caller).
 * @returns The headers.
 */
export function requestHeaders(
  row: McpServer,
  bot: Pick<Bot, "id" | "projectId" | "slug"> | null,
  opened: OpenedCredentials,
): Record<string, string> {
  switch (row.authMode) {
    case "headers":
      return Object.fromEntries(
        Object.entries(opened.headers).map(([k, v]) => [k, fillHeader(v, bot)]),
      );
    case "bearer":
      return opened.bearer ? { authorization: `Bearer ${opened.bearer}` } : {};
    case "oauth":
      return opened.oauthTokens
        ? { authorization: `Bearer ${opened.oauthTokens.accessToken}` }
        : {};
    default:
      return {};
  }
}

/**
 * Every credential value a server holds, for scrubbing a result that echoes
 * one. Includes each header value both as stored and as filled for the bot.
 * @param row - The server.
 * @param bot - The bot, if any.
 * @returns The values, longest first, at least 6 characters each.
 */
export function credentialValues(
  row: McpServer,
  bot: Pick<Bot, "id" | "projectId" | "slug"> | null,
): string[] {
  const opened = openCredentials(row);
  const values = [
    ...Object.values(opened.headers),
    ...Object.values(opened.headers).map((v) => fillHeader(v, bot)),
    opened.bearer,
    opened.oauthTokens?.accessToken,
    opened.oauthTokens?.refreshToken,
    opened.oauthClient?.clientSecret,
  ].filter((v): v is string => typeof v === "string" && v.length >= 6);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * A digest of what a pooled client was built with, so a credential change or a
 * different bot's header values never reuse a client.
 * @param row - The server.
 * @param headers - The headers the client sends.
 * @returns The pool key.
 */
export function poolKey(
  row: McpServer,
  headers: Record<string, string>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(Object.entries(headers).sort()))
    .digest("hex")
    .slice(0, 16);
  return `${row.id}:${row.credentialVersion}:${digest}`;
}

/**
 * Refuse a URL the server may not reach: not http(s), credentials in it, or
 * (outside test) not https or not public. Checked at configuration and again
 * by the guarded fetch at every connect.
 * @param url - The URL.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming why.
 */
export async function assertUsableServerUrl(url: string): Promise<void> {
  const refusal = await urlRefusal(url);
  if (refusal) {
    throw new TypedError({
      message: refusal.replace("The base URL", "The URL"),
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "url",
    });
  }
}

/**
 * Load a server of a project, or the 404.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param mcpServerId - The server.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadMcpServer(
  db: DbHandle,
  projectId: number,
  mcpServerId: number,
): Promise<McpServer> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(
      and(eq(mcpServers.id, mcpServerId), eq(mcpServers.projectId, projectId)),
    )
    .limit(1);
  if (!row) {
    throw new TypedError({
      message: "MCP server not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * Refuse a name another server of the project has.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param name - The name.
 * @param exceptId - The server being renamed, if any.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export async function assertServerNameFree(
  db: DbHandle,
  projectId: number,
  name: string,
  exceptId?: number,
): Promise<void> {
  const [taken] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.projectId, projectId), eq(mcpServers.name, name)))
    .limit(1);
  if (taken && taken.id !== exceptId) {
    throw new TypedError({
      message: `This project already has an MCP server named "${name}".`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "name",
    });
  }
}
