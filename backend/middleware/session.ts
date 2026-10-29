import {
  type ActionMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import {
  CLI_TOKEN_PREFIX,
  INVALID_TOKEN_MESSAGE,
  resolveCliToken,
} from "../ops/CliTokenOps";
import { bearerToken } from "../ops/RawRequestOps";

/**
 * The session shape Hypotenuse stores in Redis: the signed-in user's id and
 * nothing else. Everything about the caller — their organizations, projects,
 * and tags — is read from the database per request, so a permission change takes
 * effect on the next request rather than at the next sign-in.
 */
export type SessionImpl = { userId?: number };

/**
 * Which principal a request resolved to.
 *
 * - `session` — a browser (or Keryx OAuth MCP client) with a signed-in session.
 * - `cli` — a `hyp_cli_…` bearer token; acts as its person on human actions.
 * - `none` — nobody; public actions only.
 *
 * The sandbox run token is a principal too, resolved by its own middleware once
 * sandboxes exist. It is never accepted here.
 */
export type Principal =
  | { kind: "session"; userId: number }
  | { kind: "cli"; userId: number; cliTokenId: number }
  | { kind: "none" };

/** The connection metadata the principal resolver writes. */
export interface PrincipalMeta {
  /** Who this request is, as resolved by {@link resolvePrincipal}. */
  principal?: Principal;
}

/**
 * Requires an authenticated session. Throws `CONNECTION_SESSION_NOT_FOUND`
 * (HTTP 401) when the connection carries no `userId`, so every action behind it
 * can safely read `connection.session!.data.userId!`.
 */
export const SessionMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection: Connection<SessionImpl>) => {
    if (!connection.session?.data.userId) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
  },
};

/**
 * Requires a signed-in **browser** session — not a CLI token. For the browser
 * hops of CLI sign-in (`cli-auth:approve`, `cli-auth:activate`): a CLI token
 * approving another CLI would let one sign-in mint more with no person looking
 * at a dashboard page. Throws 401 when signed out, 403 for a CLI token.
 */
export const BrowserSessionMiddleware: ActionMiddleware = {
  runBefore: async (params, connection: Connection<SessionImpl>) => {
    await SessionMiddleware.runBefore?.(params, connection);
    const meta = (connection as Connection<SessionImpl, PrincipalMeta>)
      .metadata;
    if (meta.principal?.kind !== "session") {
      throw new TypedError({
        message: "Approve a CLI sign-in from the dashboard",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};

/**
 * The `beforeAct` hook that resolves exactly one principal per request.
 *
 * A signed-in session comes first. Otherwise a bearer token is read off the
 * request: a live `hyp_cli_…` token sets the session's `userId` **in memory
 * only** — nothing is written to the Redis session, so the token, not a cookie,
 * stays the credential — and every human action then sees its person exactly as
 * it would a browser. A presented CLI token that does not authenticate
 * (unknown, revoked, or expired) is refused with one 401 whose body does not
 * say which, even on a public action, so a stale CLI learns it is signed out.
 *
 * Bearer tokens without the `hyp_cli_` prefix are left alone: Keryx's own OAuth
 * access tokens on `/mcp` are not ours to judge.
 * @param _actionName - The action being run (unused).
 * @param _params - Its validated params (unused).
 * @param connection - The connection, whose session and metadata are written.
 */
export async function resolvePrincipal(
  _actionName: string,
  _params: Record<string, unknown>,
  connection: Connection,
): Promise<void> {
  const conn = connection as Connection<SessionImpl, PrincipalMeta>;
  const sessionUserId = conn.session?.data.userId;
  const token = conn.rawRequest ? bearerToken(conn.rawRequest) : null;
  let principal: Principal = { kind: "none" };

  if (sessionUserId) {
    principal = { kind: "session", userId: sessionUserId };
  } else if (token?.startsWith(CLI_TOKEN_PREFIX)) {
    const row = await resolveCliToken(token);
    if (!row) throw invalidToken();
    principal = { kind: "cli", userId: row.userId, cliTokenId: row.id };
    if (conn.session) {
      conn.session.data = { ...conn.session.data, userId: row.userId };
    }
  }

  conn.metadata.principal = principal;
}

/**
 * The single refusal for a bearer token that does not authenticate.
 * @returns A 401 typed error.
 */
function invalidToken(): TypedError {
  return new TypedError({
    message: INVALID_TOKEN_MESSAGE,
    type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
  });
}
