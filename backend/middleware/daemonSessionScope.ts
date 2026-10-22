import { and, eq, inArray } from "drizzle-orm";
import { type ActionMiddleware, api, type Connection } from "keryx";
import { roleMayCall } from "../ops/DaemonToolPolicyOps";
import { type AgentSession, agentSessions } from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import {
  HELD_WORK_STATUSES,
  type WorkItem,
  workItems,
} from "../schema/work_items";
import type { RunnerMeta } from "./runnerToken";

/**
 * The session an agent tool's call acts for, as the server re-derives it on
 * every request: never from what the daemon says beyond `agentSessionId`.
 */
export interface DaemonScope {
  session: AgentSession;
  /** The session's live turn, held by this runner. */
  item: WorkItem;
  /** The integration the session belongs to; it is `active`. */
  integration: Integration;
  role: "manager" | "worker";
}

/** The connection metadata the scope middleware writes. */
export interface DaemonScopeMeta extends RunnerMeta {
  /** The resolved scope, or null when the call is refused. */
  daemonScope?: DaemonScope | null;
}

/** The one message every scope refusal carries, whatever the reason. */
export const NOT_PERMITTED_MESSAGE = "not permitted for this session";

/**
 * The refusal for any call outside its session's scope: **byte-identical**
 * whatever the reason — no such session, another runner's or another
 * project's, a turn that is over or stopping, a disconnected integration, or
 * a tool the role does not have — so a runner cannot probe which sessions
 * exist. Built by hand rather than as a `TypedError`, whose envelope carries
 * a timestamp.
 * @returns A 403.
 */
export function notPermittedResponse(): Response {
  return Response.json(
    { error: { message: NOT_PERMITTED_MESSAGE } },
    { status: 403 },
  );
}

/**
 * Re-derive an agent tool call's scope from the session row, for one action.
 * Runs after the principal hook has resolved and checked the runner (a
 * revoked runner never gets here) and after the per-runner rate limit. In
 * order:
 *
 * 1. the session exists, in the runner's project;
 * 2. its live turn (`claimed` or `running`, no stop requested) is held by
 *    **this** runner — so a runner cannot act on a session it does not hold
 *    now, its own past sessions included;
 * 3. the session's integration is `active`;
 * 4. the action is in the role's allowlist (`DaemonToolPolicyOps`).
 *
 * The verdict goes on `connection.metadata.daemonScope` — the scope, or null
 * — because Keryx middleware can only refuse with a `TypedError`, whose body
 * is not byte-identical; `DaemonToolAction.run` answers a null with
 * {@link notPermittedResponse}. A factory taking the action's name, because
 * middleware is not told which action it guards.
 * @param actionName - The tool action this instance guards.
 * @returns The middleware.
 */
export function DaemonSessionScopeMiddleware(
  actionName: string,
): ActionMiddleware {
  return {
    runBefore: async (params, connection: Connection) => {
      const meta = (
        connection as Connection<Record<string, unknown>, DaemonScopeMeta>
      ).metadata;
      meta.daemonScope = await resolveScope(
        meta.runner?.id ?? null,
        meta.runner?.projectId ?? null,
        (params as { agentSessionId?: unknown }).agentSessionId,
        actionName,
      );
    },
  };
}

/**
 * The scope of one call, or null to refuse it.
 * @param runnerId - The calling runner.
 * @param projectId - The runner's project.
 * @param agentSessionId - The session the call names.
 * @param actionName - The action.
 * @returns The scope, or null.
 */
export async function resolveScope(
  runnerId: number | null,
  projectId: number | null,
  agentSessionId: unknown,
  actionName: string,
): Promise<DaemonScope | null> {
  if (
    runnerId === null ||
    projectId === null ||
    typeof agentSessionId !== "number" ||
    !Number.isInteger(agentSessionId)
  ) {
    return null;
  }
  const [session] = await api.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .limit(1);
  if (!session || session.projectId !== projectId) return null;

  const [item] = await api.db.db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, session.id),
        inArray(workItems.status, [...HELD_WORK_STATUSES]),
      ),
    )
    .limit(1);
  if (!item || item.runnerId !== runnerId || item.cancelRequestedAt !== null) {
    return null;
  }

  const [integration] = await api.db.db
    .select()
    .from(integrations)
    .where(eq(integrations.id, session.integrationId))
    .limit(1);
  if (!integration || integration.status !== "active") return null;

  const role = item.role ?? session.role;
  if (!role || !roleMayCall(role, actionName)) return null;
  return { session, item, integration, role };
}
