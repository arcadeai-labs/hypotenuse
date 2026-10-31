import { and, count, desc, eq, ilike } from "drizzle-orm";
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
import { serializeParticipant } from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { participants } from "../../schema/participants";

/**
 * `participant:list` — the platform people who have written to the
 * project's bots, newest seen first. Requires membership.
 */
export class ParticipantList implements Action {
  name = "participant:list";
  description =
    "List the people on platforms (Slack, Linear, Pylon, webhook) who have written to this project's bots: their platform ids and display names, when first and last seen. They are not Hypotenuse users and are never linked to one. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/participants", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    type: z.string().trim().max(40).optional().describe("Only this platform"),
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Only names containing this"),
  });

  /**
   * @param params - The inputs.
   * @returns The participants and pagination metadata.
   */
  async run(params: ActionParams<ParticipantList>) {
    const where = and(
      eq(participants.projectId, params.projectId),
      params.type ? eq(participants.type, params.type) : undefined,
      params.query
        ? ilike(
            participants.displayName,
            `%${params.query.replace(/[%_]/g, "")}%`,
          )
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(participants)
        .where(where)
        .orderBy(desc(participants.lastSeenAt))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(participants).where(where),
      params,
    );
    return {
      participants: result.data.map(serializeParticipant),
      pagination: result.pagination,
    };
  }
}
