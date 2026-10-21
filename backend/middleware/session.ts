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
import { daemonPolicyRefusal } from "../ops/DaemonPolicyOps";
import { bearerToken } from "../ops/RawRequestOps";
import { type RunnerMeta, resolveRunner } from "./runnerToken";

/**
 * The session shape Hypotenuse stores in Redis: the signed-in user's id, or —
 * for a session `daemon:connect` minted for a runner's WebSocket — the
 * runner's id. Never both. Everything else about the caller (their projects,
 * their tags, the runner's row) is read from the database per request, so a
 * permission change or a revocation takes effect immediately rather than at
 * the next login.
 */
export type SessionImpl = { userId?: number; runnerId?: number };

/**
 * Which of the three principals a request resolved to.
 *
 * - `session` — a browser (or Keryx OAuth MCP client) with a signed-in session.
 * - `cli` — a `hyp_cli_…` bearer token; acts as its person on human actions.
 * - `runner` — a `hyp_rt_…` runner token, or a WebSocket session minted for
 *   one by `daemon:connect`; `daemon:*` actions only.
 * - `none` — nobody; public actions only.
 */
export type Principal =
  | { kind: "session"; userId: number }
  | { kind: "cli"; userId: number; cliTokenId: number }
  | { kind: "runner"; runnerId: number; projectId: number }
  | { kind: "none" };

/** The connection metadata the principal resolver writes. */
export interface PrincipalMeta extends RunnerMeta {
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
 * The wall between people and machines (rule 8), from `DaemonPolicyOps`: a
 * runner may call `daemon:*` actions and nothing else, and nobody else may
 * call them — a CLI token is its person, never a runner.
 * @param principal - Who is asking.
 * @param actionName - The action they asked for.
 * @returns A refusal to throw, or `null` to proceed.
 */
export function principalRefusal(
  principal: Principal,
  actionName: string,
): TypedError | null {
  return daemonPolicyRefusal(principal.kind, actionName);
}

/**
 * The `beforeAct` hook that resolves exactly one principal per request.
 *
 * A signed-in session comes first. Otherwise a bearer token is read off the
 * request: a live `hyp_cli_…` token sets the session's `userId` **in memory
 * only** — nothing is written to the Redis session, so the token, not a cookie,
 * stays the credential — and every human action then sees its person exactly as
 * it would a browser. A presented CLI token that does not authenticate
 * (unknown, revoked, or expired) is refused with one 401 whose body does not
 * say which.
 *
 * A runner — a `hyp_rt_…` bearer, or a session `daemon:connect` minted —
 * resolves through `resolveRunner` (`middleware/runnerToken.ts`), which
 * re-reads the runner and its owner's membership on every request. Its
 * session never carries a `userId`, so no human action can see a person
 * behind it even before the wall refuses it.
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
  const sessionRunnerId = conn.session?.data.runnerId;
  const token = conn.rawRequest ? bearerToken(conn.rawRequest) : null;
  let principal: Principal = { kind: "none" };

  if (sessionUserId) {
    principal = { kind: "session", userId: sessionUserId };
  } else if (sessionRunnerId || token?.startsWith(RUNNER_TOKEN_PREFIX)) {
    const { runner, project } = await resolveRunner(
      sessionRunnerId
        ? { kind: "session", runnerId: sessionRunnerId }
        : { kind: "token", token: token! },
      actionName,
    );
    conn.metadata.runner = runner;
    conn.metadata.project = project;
    principal = {
      kind: "runner",
      runnerId: runner.id,
      projectId: runner.projectId,
    };
  } else if (token?.startsWith(CLI_TOKEN_PREFIX)) {
    const row = await resolveCliToken(token);
    if (!row) throw invalidToken();
    principal = { kind: "cli", userId: row.userId, cliTokenId: row.id };
    if (conn.session) {
      conn.session.data = { ...conn.session.data, userId: row.userId };
    }
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
