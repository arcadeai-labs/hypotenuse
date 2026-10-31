import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { botStanding, loadReadableBot, serializeBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { botPersona } from "../../ops/PromptSectionOps";

/**
 * `bot:view` — one bot, and whether the caller may change it. Requires
 * membership and the bot's read list; an unreadable bot is the same 404 as a
 * missing one.
 */
export class BotView implements Action {
  name = "bot:view";
  description =
    "Get one bot: its identity, persona, model aliases, access lists, help tag, budget, and whether it is enabled, plus standing.canWrite (whether you may change it). Requires membership and the bot's read access; a bot you cannot read answers as not found.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bot/:botId", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot to view"),
  });

  /**
   * @param params - `projectId` and `botId`.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The bot and the caller's standing on it.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<BotView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      callerTags,
    );
    return {
      bot: serializeBot(bot, await botPersona(api.db.db, bot.id)),
      standing: botStanding(bot, callerTags),
    };
  }
}
