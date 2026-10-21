import { type Action, type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  serializeAgentSession,
  sessionInProject,
} from "../../ops/AgentSessionOps";

/**
 * `agent-session:view` — one agent session: its issue, who started it, the
 * context Linear sent, its status, plan, and links. Requires membership.
 */
export class AgentSessionView implements Action {
  name = "agent-session:view";
  description =
    "Show one Linear agent session of a project: its issue, creator, Linear's context, status, plan, summary, and external links. Requires membership in the project.";
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
   * @returns The session.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when it is not in the project.
   */
  async run(params: ActionParams<AgentSessionView>) {
    const row = await sessionInProject(params.projectId, params.id);
    return { agentSession: serializeAgentSession(row) };
  }
}
