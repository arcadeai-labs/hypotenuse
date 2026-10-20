import { eq } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only: brings the `config.linear` augmentation into every program that
// type-checks this file (the frontend reaches it through the status action).
import type {} from "../config/linear";
import {
  type LinearInstallation,
  type LinearRateLimitSnapshot,
  linearInstallations,
} from "../schema/linear_installations";
import { decryptSecret } from "./CryptoOps";
import { refreshInstallationTokens } from "./LinearOAuthOps";
import type { LinearOperation } from "./linear/operations";

/**
 * **The** Linear GraphQL client: the only module that calls `fetch` on
 * `LINEAR_API_URL`'s `/graphql`. (The OAuth token and revoke endpoints are
 * `LinearOAuthOps`, which uses {@link linearFetch} too.)
 *
 * A plain fetch client rather than `@linear/sdk`'s `LinearClient`, because the
 * rate-limit headers are on every response and the SDK hides the response; the
 * agent fields reach the schema before the SDK's helpers; the activity outbox
 * passes a client id on `agentActivityCreate` exactly; and tests point one base
 * URL at finear.
 */

/** Linear answered `RATELIMITED`. Callers in a task re-enqueue at `resetAt`. */
export class LinearRateLimitedError extends Error {
  /** Epoch ms when the exhausted budget resets, if Linear said. */
  readonly resetAt: number | null;
  /** The refusing response's headers, so the budget it reports is recorded. */
  readonly headers: Headers;

  /**
   * @param message - Linear's message.
   * @param resetAt - When the budget resets, epoch ms.
   * @param headers - The response's headers.
   */
  constructor(message: string, resetAt: number | null, headers: Headers) {
    super(message);
    this.name = "LinearRateLimitedError";
    this.resetAt = resetAt;
    this.headers = headers;
  }
}

/** One error from a GraphQL response, as Linear shapes it. */
export interface LinearGraphQLErrorEntry {
  message: string;
  extensions?: Record<string, unknown>;
  path?: (string | number)[];
}

/** Linear answered with GraphQL errors (and no rate limit). */
export class LinearGraphQLError extends Error {
  /** Every error Linear returned. */
  readonly errors: LinearGraphQLErrorEntry[];

  /**
   * @param errors - The response's `errors` array.
   */
  constructor(errors: LinearGraphQLErrorEntry[]) {
    super(errors.map((e) => e.message).join("; ") || "Linear GraphQL error");
    this.name = "LinearGraphQLError";
    this.errors = errors;
  }
}

/** Linear could not be reached, timed out, or answered 5xx. Retryable. */
export class LinearUnavailableError extends Error {
  /**
   * @param message - What went wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "LinearUnavailableError";
  }
}

/**
 * The installation cannot act in Linear: it was disconnected, its refresh was
 * refused, or it holds no token. Nothing retries this; an admin reconnects.
 */
export class LinearInstallationUnavailableError extends Error {
  /**
   * @param message - Why.
   */
  constructor(message: string) {
    super(message);
    this.name = "LinearInstallationUnavailableError";
  }
}

/**
 * Join a path onto this deployment's public API origin (`APPLICATION_URL`),
 * under the API route prefix.
 * @param path - Route beneath the API prefix, starting with `/`.
 * @returns The absolute URL.
 */
function apiUrl(path: string): string {
  const origin = config.server.web.applicationUrl.replace(/\/+$/, "");
  return `${origin}${config.server.web.apiRoute}${path}`;
}

/**
 * Where Linear delivers this deployment's webhooks. Pasted into the Linear OAuth
 * app's settings; it must be public HTTPS, so in development it is the tunnel.
 * @returns The absolute webhook URL.
 */
export function linearWebhookUrl(): string {
  return apiUrl("/webhooks/linear");
}

/**
 * Where Linear redirects after a workspace admin approves the install. Must match
 * a redirect URI registered on the Linear OAuth app exactly.
 * @returns The absolute OAuth callback URL.
 */
export function linearCallbackUrl(): string {
  return apiUrl("/linear/callback");
}

/**
 * Whether the Linear OAuth app's credentials are present. Says nothing about
 * whether they are right — only the OAuth flow can.
 * @returns True when client id, client secret, and webhook secret are all set.
 */
export function linearConfigured(): boolean {
  const { clientId, clientSecret, webhookSecret } = config.linear;
  return Boolean(clientId && clientSecret && webhookSecret);
}

/**
 * A URL on Linear's API origin.
 * @param path - `/graphql`, `/oauth/token`, or `/oauth/revoke`.
 * @returns The absolute URL.
 */
export function linearApiEndpoint(path: string): string {
  return `${config.linear.apiUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * `fetch` against Linear with the configured deadline, turning a network
 * failure or a timeout into {@link LinearUnavailableError}. Every request this
 * application makes to Linear goes through here.
 * @param path - The path on Linear's API origin.
 * @param init - The request.
 * @returns The response, whatever its status.
 * @throws {LinearUnavailableError} When no response arrived.
 */
export async function linearFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(linearApiEndpoint(path), {
      ...init,
      signal: AbortSignal.timeout(config.linear.requestTimeoutMs),
    });
  } catch (e) {
    throw new LinearUnavailableError(
      `Linear did not answer: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Read one integer header.
 * @param headers - The response headers.
 * @param name - The header name.
 * @returns Its value, or null when absent or not a number.
 */
function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The rate-limit headers on a Linear response. Reset headers are epoch ms.
 * @param headers - The response headers.
 * @returns The snapshot, or null when Linear sent none of them.
 */
export function parseRateLimitHeaders(
  headers: Headers,
): LinearRateLimitSnapshot | null {
  const snapshot: LinearRateLimitSnapshot = {
    requestsLimit: intHeader(headers, "x-ratelimit-requests-limit"),
    requestsRemaining: intHeader(headers, "x-ratelimit-requests-remaining"),
    requestsResetAt: intHeader(headers, "x-ratelimit-requests-reset"),
    complexityLimit: intHeader(headers, "x-ratelimit-complexity-limit"),
    complexityRemaining: intHeader(headers, "x-ratelimit-complexity-remaining"),
    complexityResetAt: intHeader(headers, "x-ratelimit-complexity-reset"),
    lastComplexity: intHeader(headers, "x-complexity"),
    observedAt: Date.now(),
  };
  const seen = Object.entries(snapshot).some(
    ([key, value]) => key !== "observedAt" && value !== null,
  );
  return seen ? snapshot : null;
}

/** The Redis hash holding an installation's last-seen rate-limit headers. */
export function rateLimitKey(installationId: number): string {
  return `linear:ratelimit:${installationId}`;
}

/** At most one `rateLimit` column write per installation per this long. */
const RATE_LIMIT_WRITE_INTERVAL_MS = 10_000;

/**
 * Record what a response said about the installation's budget: always into
 * the Redis hash the outbox's token bucket reads, and into the row at most once
 * per {@link RATE_LIMIT_WRITE_INTERVAL_MS} so a busy session is not an UPDATE
 * per activity.
 * @param installationId - The installation the request ran as.
 * @param snapshot - The parsed headers.
 */
export async function recordRateLimit(
  installationId: number,
  snapshot: LinearRateLimitSnapshot,
): Promise<void> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== null) fields[key] = String(value);
  }
  await api.redis.redis.hset(rateLimitKey(installationId), fields);
  const claimed = await api.redis.redis.set(
    `${rateLimitKey(installationId)}:written`,
    "1",
    "PX",
    RATE_LIMIT_WRITE_INTERVAL_MS,
    "NX",
  );
  if (claimed === "OK") {
    await api.db.db
      .update(linearInstallations)
      .set({ rateLimit: snapshot })
      .where(eq(linearInstallations.id, installationId));
  }
}

/** What one GraphQL POST answered. */
interface GraphQLReply<T> {
  status: number;
  headers: Headers;
  data: T | null;
  errors: LinearGraphQLErrorEntry[];
}

/**
 * POST one GraphQL document with a bearer token and classify the answer. No
 * refresh and no retry: {@link linearRequest} adds those for installations, and
 * the install callback calls this directly with a token no row holds yet.
 * @param accessToken - The OAuth access token.
 * @param op - The operation.
 * @param variables - Its variables.
 * @returns The reply. A 401 is returned, not thrown, so the caller can refresh.
 * @throws {LinearRateLimitedError} On `RATELIMITED`.
 * @throws {LinearUnavailableError} On no response, a 5xx, or an unreadable body.
 * @throws {LinearGraphQLError} On any other GraphQL error.
 */
export async function postGraphQL<T, V>(
  accessToken: string,
  op: LinearOperation<T, V>,
  variables: V,
): Promise<GraphQLReply<T>> {
  const response = await linearFetch("/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: op.query,
      variables,
      operationName: op.name,
    }),
  });

  if (response.status === 401) {
    return { status: 401, headers: response.headers, data: null, errors: [] };
  }
  if (response.status >= 500) {
    throw new LinearUnavailableError(`Linear answered HTTP ${response.status}`);
  }

  let body: { data?: T | null; errors?: LinearGraphQLErrorEntry[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new LinearUnavailableError(
      `Linear answered HTTP ${response.status} with a body that is not JSON`,
    );
  }
  const errors = body.errors ?? [];
  const reply: GraphQLReply<T> = {
    status: response.status,
    headers: response.headers,
    data: body.data ?? null,
    errors,
  };

  if (errors.some((e) => e.extensions?.code === "RATELIMITED")) {
    const limits = parseRateLimitHeaders(response.headers);
    const resets = [limits?.requestsResetAt, limits?.complexityResetAt].filter(
      (v): v is number => typeof v === "number",
    );
    throw new LinearRateLimitedError(
      errors.find((e) => e.extensions?.code === "RATELIMITED")?.message ??
        "Rate limit exceeded",
      resets.length > 0 ? Math.max(...resets) : null,
      response.headers,
    );
  }
  if (errors.length > 0) throw new LinearGraphQLError(errors);
  if (reply.data === null) {
    throw new LinearUnavailableError("Linear answered with no data");
  }
  return reply;
}

/** Options for {@link linearRequest}. */
export interface LinearRequestOptions {
  /**
   * Safe to send twice: a query, or a mutation that carries a client id. Only
   * these are retried after a {@link LinearUnavailableError}.
   */
  idempotent?: boolean;
}

/**
 * The installation's access token, decrypted.
 * @param installation - The row.
 * @returns The plaintext token.
 * @throws {LinearInstallationUnavailableError} When the row cannot act.
 */
function accessTokenOf(installation: LinearInstallation): string {
  if (installation.status !== "active" || !installation.accessTokenEncrypted) {
    throw new LinearInstallationUnavailableError(
      installation.status === "revoked"
        ? "This Linear workspace was disconnected"
        : "This Linear connection needs an admin to reconnect it",
    );
  }
  return decryptSecret(installation.accessTokenEncrypted);
}

/**
 * Run one GraphQL operation as the installation's app user.
 *
 * - A 401 refreshes the tokens once, through the same row-locked refresh the
 *   clock uses, and retries once with the new token.
 * - Rate-limit headers on every response are recorded (see
 *   {@link recordRateLimit}).
 * - An {@link LinearRequestOptions.idempotent} operation is retried once after
 *   {@link LinearUnavailableError}; nothing ever sleeps here, so a request
 *   waiting on Linear waits at most two deadlines.
 * - Logs the operation, installation, duration, and complexity — never the
 *   variables, which can carry issue content.
 * @param installation - The installation to act as.
 * @param op - The operation.
 * @param variables - Its variables.
 * @param options - Retry behaviour.
 * @returns The operation's `data`.
 * @throws {LinearRateLimitedError} When Linear says `RATELIMITED`.
 * @throws {LinearGraphQLError} On any other GraphQL error.
 * @throws {LinearUnavailableError} When Linear stayed unreachable.
 * @throws {LinearInstallationUnavailableError} When the installation cannot act.
 */
export async function linearRequest<T, V>(
  installation: LinearInstallation,
  op: LinearOperation<T, V>,
  variables: V,
  options: LinearRequestOptions = {},
): Promise<T> {
  const started = Date.now();
  let token = accessTokenOf(installation);
  let refreshed = false;
  let retried = false;

  for (;;) {
    let reply: GraphQLReply<T>;
    try {
      reply = await postGraphQL(token, op, variables);
    } catch (e) {
      if (e instanceof LinearRateLimitedError) {
        const limits = parseRateLimitHeaders(e.headers);
        if (limits) await recordRateLimit(installation.id, limits);
      }
      if (e instanceof LinearUnavailableError && options.idempotent) {
        if (!retried) {
          retried = true;
          continue;
        }
      }
      api.logger.warn("linear request failed", {
        operation: op.name,
        installationId: installation.id,
        durationMs: Date.now() - started,
        error: e instanceof Error ? e.name : "unknown",
      });
      throw e;
    }

    if (reply.status === 401) {
      if (refreshed) {
        throw new LinearInstallationUnavailableError(
          "Linear refused a freshly refreshed token",
        );
      }
      refreshed = true;
      const row = await refreshInstallationTokens(installation.id, {
        rejectedAccessToken: token,
      });
      token = accessTokenOf(row);
      continue;
    }

    const limits = parseRateLimitHeaders(reply.headers);
    if (limits) await recordRateLimit(installation.id, limits);
    api.logger.info("linear request", {
      operation: op.name,
      installationId: installation.id,
      durationMs: Date.now() - started,
      complexity: limits?.lastComplexity ?? null,
    });
    return reply.data as T;
  }
}

/**
 * Translate a Linear failure into the typed error an action answers with: a
 * rate limit becomes the caller's own 429, an unreachable Linear or a
 * disconnected installation a clear refusal. Anything else is rethrown.
 * @param e - What a Linear call threw.
 * @returns The typed error to throw.
 */
export function linearErrorToTypedError(e: unknown): unknown {
  if (e instanceof LinearRateLimitedError) {
    return new TypedError({
      message:
        "Linear's rate limit is exhausted for this workspace; try again shortly",
      type: ErrorType.CONNECTION_RATE_LIMITED,
    });
  }
  if (e instanceof LinearInstallationUnavailableError) {
    return new TypedError({
      message: e.message,
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  if (e instanceof LinearUnavailableError || e instanceof LinearGraphQLError) {
    return new TypedError({
      message: `Linear could not answer: ${e.message}`,
      type: ErrorType.CONNECTION_SERVER_ERROR,
    });
  }
  return e;
}

/**
 * A project's installation, whatever its status.
 * @param projectId - The project.
 * @returns The row, or null when the project never connected Linear.
 */
export async function getInstallationForProject(
  projectId: number,
): Promise<LinearInstallation | null> {
  const [row] = await api.db.db
    .select()
    .from(linearInstallations)
    .where(eq(linearInstallations.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * An installation as every API answers it. There is no field either token, or
 * either ciphertext, fits in.
 * @param row - The row.
 * @returns The safe view, timestamps as epoch ms.
 */
export function serializeLinearInstallation(row: LinearInstallation) {
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    urlKey: row.urlKey,
    appUserId: row.appUserId,
    appUserName: row.appUserName,
    appUserCapabilities: row.appUserCapabilities,
    scopes: row.scopes,
    status: row.status,
    accessTokenLastFour: row.accessTokenLastFour,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.getTime() ?? null,
    connectedAt: row.connectedAt.getTime(),
    lastRefreshedAt: row.lastRefreshedAt?.getTime() ?? null,
    refreshFailedAt: row.refreshFailedAt?.getTime() ?? null,
    refreshError: row.refreshError,
    teamIds: row.teamIds,
    canAccessAllPublicTeams: row.canAccessAllPublicTeams,
    rateLimit: row.rateLimit,
    installedByUserId: row.installedByUserId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** {@link serializeLinearInstallation}'s output. */
export type SerializedLinearInstallation = ReturnType<
  typeof serializeLinearInstallation
>;
