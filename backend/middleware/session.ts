import {
  type ActionMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import {
  CLI_TOKEN_PREFIX,
  INVALID_TOKEN_MESSAGE,
  RUNNER_TOKEN_PREFIX,
  resolveCliToken,
} from "../ops/CliTokenOps";
import { bearerToken } from "../ops/RawRequestOps";

/**
 * The session shape Hypotenuse stores in Redis: just the signed-in user's id.
 * Everything else about the caller (their projects, their tags) is read from the
 * database per request, so a permission change takes effect immediately rather
 * than at the next login.
 */
export type SessionImpl = { userId?: number };

/**
 * Which of the three principals a request resolved to.
 *
 * - `session` — a browser (or Keryx OAuth MCP client) with a signed-in session.
 * - `cli` — a `hyp_cli_…` bearer token; acts as its person on human actions.
 * - `none` — nobody; public actions only.
 *
 * Runner tokens (`hyp_rt_…`) join this list when runners exist; until then one
 * authenticates nothing, which already satisfies the rule that a runner token
 * is refused on every human action.
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
 * Whether a principal may run an action at all, before any RBAC middleware.
 *
 * The wall between people and machines (rule 8): a CLI token is its person, but
 * never on a `daemon:*` action, which belong to runner tokens. Exported so the
 * rule is testable before any `daemon:*` action exists.
 * @param principal - Who is asking.
 * @param actionName - The action they asked for.
 * @returns A refusal to throw, or `null` to proceed.
 */
export function principalRefusal(
  principal: Principal,
  actionName: string,
): TypedError | null {
  if (principal.kind === "cli" && actionName.startsWith("daemon:")) {
    return new TypedError({
      message: "A CLI sign-in cannot call daemon actions",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
  return null;
}

/**
 * The `beforeAct` hook that resolves exactly one principal per request.
 *
 * A signed-in session comes first. Otherwise a bearer token is read off the
 * request: a live `hyp_cli_…` token sets the session's `userId` **in memory
 * only** — nothing is written to the Redis session, so the token, not a cookie,
 * stays the credential — and every human action then sees its person exactly as
 * it would a browser. A presented token that does not authenticate (unknown,
 * revoked, expired, or a runner token on a human action) is refused with one
 * 401 whose body does not say which.
 *
 * Bearer tokens without a Hypotenuse prefix are left alone: Keryx's own OAuth
 * access tokens on `/mcp` are not ours to judge.
 * @param actionName - The action being run.
 * @param _params - Its validated params (unused).
 * @param connection - The connection, whose session and metadata are written.
 */
export async function resolvePrincipal(
  actionName: string,
  _params: Record<string, unknown>,
  connection: Connection,
): Promise<void> {
  const conn = connection as Connection<SessionImpl, PrincipalMeta>;
  const sessionUserId = conn.session?.data.userId;
  if (sessionUserId) {
    conn.metadata.principal = { kind: "session", userId: sessionUserId };
    return;
  }

  const token = conn.rawRequest ? bearerToken(conn.rawRequest) : null;
  let principal: Principal = { kind: "none" };

  if (token?.startsWith(CLI_TOKEN_PREFIX)) {
    const row = await resolveCliToken(token);
    if (!row) throw invalidToken();
    principal = { kind: "cli", userId: row.userId, cliTokenId: row.id };
    if (conn.session) {
      conn.session.data = { ...conn.session.data, userId: row.userId };
    }
  } else if (token?.startsWith(RUNNER_TOKEN_PREFIX)) {
    throw invalidToken();
  }

  conn.metadata.principal = principal;
  const refusal = principalRefusal(principal, actionName);
  if (refusal) throw refusal;
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
