import { and, desc, eq, inArray } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  serializeAgentSession,
  sessionInProject,
} from "../../ops/AgentSessionOps";
import { type AgentSession, agentSessions } from "../../schema/agent_sessions";
import { workItems } from "../../schema/work_items";

/**
 * `agent-session:view` — one agent session: its issue, who started it, the
 * context Linear sent, its status, plan, and links — and, for a manager's
 * dispatches, the tree: the session that dispatched it (`parent`) and the
 * sessions it dispatched (`children`), each with its review round, pull
 * requests, and its latest turn's status. The server draws the tree; a
 * client only renders it. Requires membership.
 */
export class AgentSessionView implements Action {
  name = "agent-session:view";
  description =
    "Show one Linear agent session of a project: its issue, creator, Linear's context, status, plan, summary, and external links; the manager session that dispatched it, if any; and the worker sessions it dispatched, with their review rounds and pull requests. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/agent-session/:id", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the session belongs to"),
    id: z.coerce.number().int().positive().describe("The agent session's id"),
  });

  /**
   * @param params - The project and session.
   * @returns The session, its parent, and its children.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the project.
   */
  async run(params: ActionParams<AgentSessionView>) {
    const row = await sessionInProject(params.projectId, params.id);
    const [parent] = row.parentAgentSessionId
      ? await api.db.db
          .select()
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.id, row.parentAgentSessionId),
              eq(agentSessions.projectId, params.projectId),
            ),
          )
      : [];
    const children = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.parentAgentSessionId, row.id))
      .orderBy(agentSessions.id);
    const latest = await latestWorkStatus(children.map((c) => c.id));
    return {
      agentSession: serializeAgentSession(row),
      parent: parent ? sessionLink(parent) : null,
      children: children.map((child) => ({
        ...sessionLink(child),
        issueTitle: child.issueTitle,
        dispatchMode: child.dispatchMode,
        reviewRound: child.reviewRound,
        pullRequests: child.externalUrls.filter((u) =>
          /^pull request/i.test(u.label),
        ),
        workStatus: latest.get(child.id) ?? null,
      })),
    };
  }
}

/**
 * A session as a link in the dispatch tree.
 * @param row - The session.
 * @returns Its id, issue, status, and role.
 */
function sessionLink(row: AgentSession) {
  return {
    id: row.id,
    issueIdentifier: row.issueIdentifier,
    issueUrl: row.issueUrl,
    status: row.status,
    role: row.role,
  };
}

/**
 * The status of each session's latest turn.
 * @param agentSessionIds - The sessions.
 * @returns Session id → status.
 */
async function latestWorkStatus(
  agentSessionIds: number[],
): Promise<Map<number, string>> {
  if (agentSessionIds.length === 0) return new Map();
  const rows = await api.db.db
    .selectDistinctOn([workItems.agentSessionId], {
      agentSessionId: workItems.agentSessionId,
      status: workItems.status,
    })
    .from(workItems)
    .where(inArray(workItems.agentSessionId, agentSessionIds))
    .orderBy(workItems.agentSessionId, desc(workItems.id));
  return new Map(rows.map((r) => [r.agentSessionId, r.status]));
}
