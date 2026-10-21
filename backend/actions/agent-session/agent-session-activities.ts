import { and, asc, count, eq, gt } from "drizzle-orm";
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
import { serializeActivity, sessionInProject } from "../../ops/AgentSessionOps";
import { agentActivities } from "../../schema/agent_activities";

/**
 * `agent-session:activities` — a session's conversation in order: the prompts
 * people typed and everything Hypotenuse wrote, with each outbound write's
 * delivery state (`pending`, `sent`, `failed`, `superseded`). `afterSeq`
 * reads only what is new since a previous page. Requires membership. Paginated.
 */
export class AgentSessionActivities implements Action {
  name = "agent-session:activities";
  description =
    "List one agent session's activities in order, both directions: prompts people typed and what Hypotenuse wrote, with each write's delivery status. Pass afterSeq to read only newer ones. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/agent-session/:id/activities", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the session belongs to"),
    id: z.coerce.number().int().positive().describe("The agent session's id"),
    afterSeq: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only activities after this sequence number"),
  });

  /**
   * @param params - The project, session, cursor, and pagination.
   * @returns This page of activities, oldest first, plus pagination metadata.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` when the session is not in the project.
   */
  async run(params: ActionParams<AgentSessionActivities>) {
    const session = await sessionInProject(params.projectId, params.id);
    const where = and(
      eq(agentActivities.agentSessionId, session.id),
      params.afterSeq !== undefined
        ? gt(agentActivities.seq, params.afterSeq)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(agentActivities)
        .where(where)
        .orderBy(asc(agentActivities.seq))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(agentActivities).where(where),
      params,
    );
    return {
      activities: result.data.map(serializeActivity),
      pagination: result.pagination,
    };
  }
}
