import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST, botStanding, serializeBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { botPersonas } from "../../ops/PromptSectionOps";
import { bots } from "../../schema/bots";

/**
 * `bot:list` — the bots of a project the caller may read, by name. Requires
 * membership. A bot whose read list the caller does not satisfy is absent,
 * not hidden: the page, the count, and the total are all computed over the
 * readable ids.
 */
export class BotList implements Action {
  name = "bot:list";
  description =
    "List the bots of a project you may read, by name, each with standing.canWrite. Bots whose read access you lack are not listed. Requires membership in the project. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bots", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project whose bots to list"),
  });

  /**
   * @param params - `projectId` plus pagination inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The readable bots, each with the caller's standing, and pagination.
   */
  async run(
    params: ActionParams<BotList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const ids = await readableIds(
      api.db.db,
      BOT_ACCESS_LIST,
      params.projectId,
      callerTags,
    );
    const where = and(
      eq(bots.projectId, params.projectId),
      inArray(bots.id, ids),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(bots)
        .where(where)
        .orderBy(asc(bots.name), asc(bots.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(bots).where(where),
      params,
    );
    const personas = await botPersonas(
      api.db.db,
      result.data.map((b) => b.id),
    );
    return {
      bots: result.data.map((bot) => ({
        ...serializeBot(bot, personas.get(bot.id) ?? ""),
        standing: botStanding(bot, callerTags),
      })),
      pagination: result.pagination,
    };
  }
}
