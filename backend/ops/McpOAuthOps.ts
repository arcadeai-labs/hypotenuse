import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
import {
  type McpOAuthClient,
  type McpOAuthTokens,
  type McpServer,
  mcpServers,
} from "../schema/mcp_servers";
import type { DbHandle } from "./DbOps";
import { openCredentials, sealJson } from "./McpServerOps";
import { guardedFetch } from "./NetworkGuardOps";

/**
 * The MCP authorization spec, as a client: discover the server's protected
 * resource metadata (RFC 9728) and its authorization server's metadata
 * (RFC 8414), register dynamically (RFC 7591) when no client id was given,
 * send an admin through PKCE (RFC 7636) with the resource indicator
 * (RFC 8707), and refresh under the row's lock. Every request goes through the
 * SSRF guard.
 */

/** A sign-in in flight, keyed by its `state`, for ten minutes. */
export interface PendingOAuth {
  mcpServerId: number;
  projectId: number;
  userId: number;
  codeVerifier: string;
  redirectUri: string;
}

/** How long a sign-in may take before its state is forgotten. */
const PENDING_TTL_SECONDS = 600;

/**
 * The Redis key of a pending sign-in.
 * @param state - The OAuth `state`.
 * @returns The key.
 */
function pendingKey(state: string): string {
  return `hyp:mcp-oauth:${state}`;
}

/**
 * The redirect URI this deployment registers: its public origin and API route.
 * @returns e.g. `https://api.example.com/api/mcp-server/oauth/callback`.
 */
export function oauthRedirectUri(): string {
  const origin = config.server.web.applicationUrl.replace(/\/+$/, "");
  return `${origin}${config.server.web.apiRoute}/mcp-server/oauth/callback`;
}

/**
 * Base64url without padding.
 * @param bytes - The bytes.
 * @returns The encoding.
 */
function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * A PKCE verifier and its S256 challenge.
 * @returns Both.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The refusal every discovery failure becomes. */
function oauthError(message: string): TypedError {
  return new TypedError({
    message,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key: "url",
  });
}

/**
 * GET a JSON document, or `null` for any non-2xx.
 * @param url - The URL.
 * @returns The parsed body, or `null`.
 */
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await guardedFetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The well-known URLs for a document, with the path inserted after the
 * well-known segment first (RFC 8414 §3.1), then at the root.
 * @param base - The resource or issuer URL.
 * @param suffix - e.g. `oauth-protected-resource`.
 * @returns Candidate URLs, best first.
 */
function wellKnown(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const out = [`${url.origin}/.well-known/${suffix}${path}`];
  if (path) out.push(`${url.origin}/.well-known/${suffix}`);
  return out;
}

/** What discovery found. */
export interface Discovered {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  resource: string;
  scope?: string;
}

/**
 * Discover a server's authorization server.
 * @param serverUrl - The MCP endpoint.
 * @returns The endpoints and the resource to ask tokens for.
 * @throws {TypedError} When no authorization server is found.
 */
export async function discover(serverUrl: string): Promise<Discovered> {
  let resourceMeta: Record<string, unknown> | null = null;
  for (const url of wellKnown(serverUrl, "oauth-protected-resource")) {
    resourceMeta = await getJson(url);
    if (resourceMeta) break;
  }
  const servers = resourceMeta?.authorization_servers;
  const issuer =
    Array.isArray(servers) && typeof servers[0] === "string"
      ? servers[0]
      : new URL(serverUrl).origin;
  const resource =
    typeof resourceMeta?.resource === "string"
      ? resourceMeta.resource
      : serverUrl;
  const scopes = resourceMeta?.scopes_supported;

  let asMeta: Record<string, unknown> | null = null;
  for (const url of [
    ...wellKnown(issuer, "oauth-authorization-server"),
    ...wellKnown(issuer, "openid-configuration"),
  ]) {
    asMeta = await getJson(url);
    if (asMeta) break;
  }
  if (
    !asMeta ||
    typeof asMeta.authorization_endpoint !== "string" ||
    typeof asMeta.token_endpoint !== "string"
  ) {
    throw oauthError(
      `No OAuth authorization server was found for ${serverUrl}. Check that the server supports MCP authorization, or connect it with headers or a bearer token instead.`,
    );
  }
  return {
    issuer,
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint:
      typeof asMeta.registration_endpoint === "string"
        ? asMeta.registration_endpoint
        : null,
    resource,
    scope:
      Array.isArray(scopes) && scopes.length > 0
        ? scopes.filter((s) => typeof s === "string").join(" ")
        : undefined,
  };
}

/**
 * Register Hypotenuse as a public client (PKCE, no secret) at an
 * authorization server.
 * @param found - What discovery found.
 * @param redirectUri - The callback.
 * @returns The client id, and a secret if the server issued one.
 * @throws {TypedError} When the server has no registration endpoint or refuses.
 */
export async function registerClient(
  found: Discovered,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!found.registrationEndpoint) {
    throw oauthError(
      "This server's authorization server does not offer dynamic client registration. Register a client there and enter its client id.",
    );
  }
  const res = await guardedFetch(found.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Hypotenuse",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.client_id !== "string") {
    throw oauthError(
      `The authorization server refused to register a client (HTTP ${res.status}).`,
    );
  }
  return {
    clientId: body.client_id,
    clientSecret:
      typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

/**
 * Begin a sign-in: discover, register if needed, store the client on the row
 * and the pending state in Redis, and answer the URL to send the admin to.
 * @param tx - The transaction the client is stored in.
 * @param server - The server.
 * @param userId - The admin signing in.
 * @returns The authorization URL and the client stored.
 */
export async function startSignIn(
  tx: DbHandle,
  server: McpServer,
  userId: number,
): Promise<{ authorizationUrl: string; client: McpOAuthClient }> {
  const redirectUri = oauthRedirectUri();
  const found = await discover(server.url);
  const existing = openCredentials(server).oauthClient;
  let client: McpOAuthClient;
  // A client an admin entered (no issuer yet), or one registered at this
  // same authorization server, is reused; anything else registers anew.
  if (
    existing &&
    (existing.issuer === "" || existing.issuer === found.issuer)
  ) {
    client = {
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
      ...endpoints(found),
    };
  } else {
    client = {
      ...(await registerClient(found, redirectUri)),
      ...endpoints(found),
    };
  }
  await tx
    .update(mcpServers)
    .set({ oauthClient: sealJson(client) })
    .where(eq(mcpServers.id, server.id));

  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));
  const pending: PendingOAuth = {
    mcpServerId: server.id,
    projectId: server.projectId,
    userId,
    codeVerifier: verifier,
    redirectUri,
  };
  await api.redis.redis.set(
    pendingKey(state),
    JSON.stringify(pending),
    "EX",
    PENDING_TTL_SECONDS,
  );
  const url = new URL(client.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", client.resource);
  if (client.scope) url.searchParams.set("scope", client.scope);
  return { authorizationUrl: url.toString(), client };
}

/**
 * The endpoint fields of a client, from discovery.
 * @param found - What discovery found.
 * @returns The fields.
 */
function endpoints(found: Discovered) {
  return {
    issuer: found.issuer,
    authorizationEndpoint: found.authorizationEndpoint,
    tokenEndpoint: found.tokenEndpoint,
    resource: found.resource,
    scope: found.scope,
  };
}

/**
 * Take a pending sign-in by its state. Works once.
 * @param state - The OAuth `state` the callback carried.
 * @returns The pending sign-in, or `null` for an unknown or used one.
 */
export async function takePending(state: string): Promise<PendingOAuth | null> {
  const raw = await api.redis.redis.getdel(pendingKey(state));
  return raw ? (JSON.parse(raw) as PendingOAuth) : null;
}

/**
 * POST a token request.
 * @param client - The client.
 * @param form - The grant's fields.
 * @returns The tokens.
 * @throws {Error} When the server refuses.
 */
async function tokenRequest(
  client: McpOAuthClient,
  form: Record<string, string>,
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    ...form,
    client_id: client.clientId,
    resource: client.resource,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const res = await guardedFetch(client.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(
      `The authorization server refused the token request (HTTP ${res.status}${typeof json.error === "string" ? `: ${json.error}` : ""}).`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken:
      typeof json.refresh_token === "string"
        ? json.refresh_token
        : (form.refresh_token ?? undefined),
    expiresAt:
      typeof json.expires_in === "number"
        ? Date.now() + json.expires_in * 1000
        : undefined,
  };
}

/**
 * Exchange the callback's code for tokens.
 * @param client - The stored client.
 * @param pending - The pending sign-in.
 * @param code - The authorization code.
 * @returns The tokens.
 */
export function exchangeCode(
  client: McpOAuthClient,
  pending: PendingOAuth,
  code: string,
): Promise<McpOAuthTokens> {
  return tokenRequest(client, {
    grant_type: "authorization_code",
    code,
    code_verifier: pending.codeVerifier,
    redirect_uri: pending.redirectUri,
  });
}

/** Refresh this long before a token's stated expiry. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Whether stored tokens are expired, or about to be.
 * @param tokens - The tokens.
 * @returns `true` to refresh first.
 */
export function tokensExpiring(tokens: McpOAuthTokens | null): boolean {
  return Boolean(
    tokens?.expiresAt && tokens.expiresAt - REFRESH_SKEW_MS <= Date.now(),
  );
}

/**
 * Refresh a server's OAuth tokens **under its row lock**, so two workers that
 * both see a 401 refresh once: the second re-reads the row and finds a newer
 * credential version than the one that failed. On refusal the server becomes
 * `needs_auth`.
 * @param mcpServerId - The server.
 * @param failedVersion - The credential version whose token failed; a newer
 *   one already stored means another worker refreshed.
 * @returns The fresh row.
 * @throws {Error} When there is nothing to refresh with, or the server refuses.
 */
export async function refreshTokens(
  mcpServerId: number,
  failedVersion: number,
): Promise<McpServer> {
  let failure = null as string | null;
  const row = await api.db.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, mcpServerId))
      .for("update");
    if (!locked) throw new Error("The MCP server was deleted.");
    if (locked.credentialVersion !== failedVersion) return locked;
    const opened = openCredentials(locked);
    if (!opened.oauthClient || !opened.oauthTokens?.refreshToken) {
      failure =
        "The sign-in expired and cannot be refreshed. An admin must sign in again.";
    } else {
      try {
        const tokens = await tokenRequest(opened.oauthClient, {
          grant_type: "refresh_token",
          refresh_token: opened.oauthTokens.refreshToken,
        });
        const [fresh] = await tx
          .update(mcpServers)
          .set({
            oauthTokens: sealJson(tokens),
            credentialVersion: sql`${mcpServers.credentialVersion} + 1`,
            status: "ok",
            lastError: null,
          })
          .where(eq(mcpServers.id, mcpServerId))
          .returning();
        return fresh;
      } catch (e) {
        failure = `${e instanceof Error ? e.message : String(e)} An admin must sign in again.`;
      }
    }
    const [marked] = await tx
      .update(mcpServers)
      .set({ status: "needs_auth", lastError: failure })
      .where(eq(mcpServers.id, mcpServerId))
      .returning();
    return marked;
  });
  if (failure) throw new Error(failure);
  return row;
}
