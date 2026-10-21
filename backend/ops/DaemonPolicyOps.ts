/**
 * The wall between the daemon's surface and the human one (rule 8).
 *
 * {@link DAEMON_ONLY_ACTION_NAMES} is the closed list of every `daemon:*`
 * action. `runner-policy.test.ts` asserts it equals the set of registered
 * actions whose name starts with `daemon:`, so the list and the prefix cannot
 * drift — and it is **not** the human `runner:*` ledger, which manages runners
 * and is named apart on purpose.
 *
 * The principal hook (`middleware/session.ts`) applies
 * {@link daemonPolicyRefusal} on every action: a runner is refused everything
 * outside the list, and everything inside it is refused to anyone but a
 * runner. A runner token carries its owner's identity; without the first half
 * it would pass `ProjectMemberMiddleware` for anything that person can do. If
 * the daemon ever needs a human action, the action is duplicated as a
 * `daemon:*` twin.
 */
import {
  PROTOCOL_UNSUPPORTED,
  SUPPORTED_PROTOCOL_RANGE,
} from "@hypotenuse/protocol";
import { config, ErrorType, TypedError } from "keryx";

/** Every action a runner token may call, and only a runner token. */
export const DAEMON_ONLY_ACTION_NAMES: ReadonlySet<string> = new Set([
  "daemon:connect",
  "daemon:heartbeat",
]);

/** The prefix every daemon action's route sits under: `/daemon/…`. */
export const DAEMON_ROUTE_PREFIX = "/daemon/";

/**
 * Whether an action belongs to the daemon's surface. The prefix is checked
 * too, so a `daemon:*` action someone forgot to list is still refused to
 * people (and then fails the registry test).
 * @param actionName - The action.
 * @returns True for a daemon action.
 */
export function isDaemonOnly(actionName: string): boolean {
  return (
    DAEMON_ONLY_ACTION_NAMES.has(actionName) || actionName.startsWith("daemon:")
  );
}

/** The kinds of principal the wall distinguishes. */
export type PolicyPrincipalKind = "session" | "cli" | "runner" | "none";

/**
 * Whether a principal may run an action at all, before any action middleware.
 * @param kind - Who is asking.
 * @param actionName - What they asked for.
 * @returns A refusal to throw, or `null` to proceed.
 */
export function daemonPolicyRefusal(
  kind: PolicyPrincipalKind,
  actionName: string,
): TypedError | null {
  const daemonAction = isDaemonOnly(actionName);
  if (kind === "runner" && !daemonAction) {
    return new TypedError({
      message: "A runner token can only call daemon actions",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
  if (kind !== "runner" && daemonAction) {
    if (kind === "cli") {
      return new TypedError({
        message: "A CLI sign-in cannot call daemon actions",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    if (kind === "session") {
      return new TypedError({
        message: "Daemon actions need a runner token",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    return new TypedError({
      message: "Daemon actions need a runner token",
      type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
    });
  }
  return null;
}

/**
 * The 426 a daemon speaking a protocol this server does not receives.
 * @returns The response, carrying the supported range.
 */
export function protocolUnsupportedResponse(): Response {
  const [min, max] = SUPPORTED_PROTOCOL_RANGE;
  return Response.json(
    {
      error: {
        type: PROTOCOL_UNSUPPORTED,
        message: `This server speaks runner protocol ${min === max ? min : `${min}–${max}`}. Run \`hypotenuse upgrade\`.`,
        supported: [min, max],
      },
    },
    { status: 426 },
  );
}

/**
 * Whether an HTTP request is for a daemon action, by its path.
 * @param req - The request.
 * @returns True under `/api/daemon/`.
 */
export function isDaemonRequest(req: Request): boolean {
  try {
    return new URL(req.url).pathname.startsWith(
      `${config.server.web.apiRoute}${DAEMON_ROUTE_PREFIX}`,
    );
  } catch {
    return false;
  }
}
