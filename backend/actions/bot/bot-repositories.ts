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
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { botRepositories } from "../../ops/RepositoryOps";

/**
 * `bot:repositories` — the repositories one bot may reach and whether it may
 * write to each: the project's grants that list the bot or every bot, through
 * installations still attached and usable. Derived from the grants rather
 * than a CRUD set of its own, and bounded by them, so it answers the whole
 * list unpaginated. Requires membership and the bot's read access.
 */
export class BotRepositories implements Action {
  name = "bot:repositories";
  description =
    "List the GitHub repositories one bot may reach, and whether it may read or also write (push) each, from the project's repository grants. Requires membership and the bot's read access; a bot you cannot read answers as not found.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/repositories",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param params - `projectId` and `botId`.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns `{ repositories }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<BotRepositories>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      params.botId,
      connection.metadata.callerTags ?? [],
    );
    return {
      repositories: await botRepositories(api.db.db, bot.projectId, bot.id),
    };
  }
}
