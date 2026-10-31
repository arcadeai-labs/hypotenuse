import { and, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { serializeParticipant } from "../../ops/ChannelOps";
import { idInput } from "../../ops/InputOps";
import { participants } from "../../schema/participants";

/**
 * `participant:view` — one platform person. Requires membership.
 */
export class ParticipantView implements Action {
  name = "participant:view";
  description =
    "Get one platform person who has written to this project's bots. Requires membership.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/participant/:participantId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    participantId: idInput("The participant"),
  });

  /**
   * @param params - The inputs.
   * @returns The participant.
   */
  async run(params: ActionParams<ParticipantView>) {
    const [row] = await api.db.db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.id, params.participantId),
          eq(participants.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TypedError({
        message: "Participant not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    return { participant: serializeParticipant(row) };
  }
}
