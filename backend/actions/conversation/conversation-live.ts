import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { loadReadableConversation } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { liveSurface } from "../../ops/SurfaceOps";

/**
 * `conversation:live` — what a working conversation is showing right now:
 * its status line, the model's text so far, and the turn's plan, each the
 * newest row still current (or null). The dashboard reads it with the
 * transcript on every content-free ping, so streamed text lives in Postgres,
 * never on a WebSocket frame. Requires membership and the bot's read access.
 */
export class ConversationLive implements Action {
  name = "conversation:live";
  description =
    'Get what a conversation is showing while the bot works: its status line ("Searching memory…"), the text it is writing so far, and the plan of the turn\'s tool steps. All null when it is resting or ended. Read the transcript with conversation:entries. Requires membership and read access to the bot.';
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/live",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The live surface and the conversation's state.
   */
  async run(
    params: ActionParams<ConversationLive>,
    connection: AuditedConnection,
  ) {
    const { conversation } = await loadReadableConversation(
      api.db.db,
      params.projectId,
      params.conversationId,
      connection.metadata.callerTags ?? [],
    );
    return {
      live: {
        conversationId: conversation.id,
        state: conversation.state,
        lastSeq: conversation.lastSeq,
        ...(await liveSurface(api.db.db, conversation)),
      },
    };
  }
}
