import { and, count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeAgentSession } from "../../ops/AgentSessionOps";
import {
  AGENT_SESSION_ROLES,
  AGENT_SESSION_STATUSES,
  agentSessions,
} from "../../schema/agent_sessions";
import { TRIGGER_TYPES } from "../../schema/integrations";

/**
 * `agent-session:list` — a project's Linear agent sessions, newest first:
 * every delegation and mention of `@hypotenuse` in the connected workspace.
 * Requires membership. Paginated.
 */
export class AgentSessionList implements Action {
  name = "agent-session:list";
  description =
    "List a project's Linear agent sessions (each time @hypotenuse was delegated an issue or mentioned), newest first, optionally filtered by trigger type, status, role, runner, or issue identifier. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/agent-sessions", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose sessions to list"),
    type: z
      .enum(TRIGGER_TYPES)
      .optional()
      .describe("Only sessions from this trigger system, e.g. linear"),
    status: z
      .enum(AGENT_SESSION_STATUSES)
      .optional()
      .describe("Only sessions in this Linear status"),
    role: z
      .enum(AGENT_SESSION_ROLES)
      .optional()
      .describe("Only sessions playing this role"),
    runnerId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only sessions held by this runner"),
    issueIdentifier: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("Only sessions on this issue, e.g. ENG-123"),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @returns This page of sessions plus pagination metadata.
   */
  async run(params: ActionParams<AgentSessionList>) {
    const where = and(
      eq(agentSessions.projectId, params.projectId),
      params.type ? eq(agentSessions.type, params.type) : undefined,
      params.status ? eq(agentSessions.status, params.status) : undefined,
      params.role ? eq(agentSessions.role, params.role) : undefined,
      params.runnerId ? eq(agentSessions.runnerId, params.runnerId) : undefined,
      params.issueIdentifier
        ? eq(
            agentSessions.issueIdentifier,
            params.issueIdentifier.toUpperCase(),
          )
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(agentSessions)
        .where(where)
        .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(agentSessions).where(where),
      params,
    );
    return {
      agentSessions: result.data.map(serializeAgentSession),
      pagination: result.pagination,
    };
  }
}
