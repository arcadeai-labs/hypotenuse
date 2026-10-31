import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { canWriteBot } from "../../ops/BotOps";
import {
  canAnswerHelp,
  loadReadableHelpRequest,
  serializeHelpRequest,
} from "../../ops/HelpOps";
import { idInput } from "../../ops/InputOps";

/**
 * `help:view` — one help request. Requires membership and the bot's read access.
 */
export class HelpView implements Action {
  name = "help:view";
  description =
    "Get one help request: the bot's question and context, its urgency, whether the bot is blocked on it, and its answer. Says whether you may answer or cancel it. Requires membership and read access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/help/:helpRequestId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    helpRequestId: idInput("The request"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The request and the caller's standing.
   */
  async run(params: ActionParams<HelpView>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const { request, bot } = await loadReadableHelpRequest(
      api.db.db,
      params.projectId,
      params.helpRequestId,
      tags,
    );
    const pending = request.status === "pending";
    return {
      helpRequest: {
        ...serializeHelpRequest(request),
        botName: bot.displayName,
      },
      standing: {
        canAnswer: pending && canAnswerHelp(bot, tags),
        canCancel: pending && canWriteBot(bot, tags),
      },
    };
  }
}
