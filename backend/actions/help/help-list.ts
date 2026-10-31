import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import { canAnswerHelp, serializeHelpRequest } from "../../ops/HelpOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";
import { HELP_STATUSES, helpRequests } from "../../schema/help_requests";

/**
 * `help:list` — the project's help inbox: requests bots raised with
 * `escalate_to_human`, newest first, for the bots the caller may read.
 * Requires membership.
 */
export class HelpList implements Action {
  name = "help:list";
  description =
    "List the help inbox: questions bots escalated to the team because nobody in their channel could answer, newest first, with urgency, whether the bot is blocked on it, and where each stands (pending, answered, expired, cancelled). Only bots you may read; each says whether you may answer it. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/help", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    status: z
      .enum(HELP_STATUSES)
      .optional()
      .describe("Only this status, e.g. pending"),
    botId: idInput("Only this bot's").optional(),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The requests and pagination metadata.
   */
  async run(params: ActionParams<HelpList>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const botIds = await readableIds(
      api.db.db,
      BOT_ACCESS_LIST,
      params.projectId,
      tags,
    );
    const where = and(
      eq(helpRequests.projectId, params.projectId),
      inArray(helpRequests.botId, botIds.length ? botIds : [-1]),
      params.status ? eq(helpRequests.status, params.status) : undefined,
      params.botId ? eq(helpRequests.botId, params.botId) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({ request: helpRequests, bot: bots })
        .from(helpRequests)
        .innerJoin(bots, eq(bots.id, helpRequests.botId))
        .where(where)
        .orderBy(desc(helpRequests.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(helpRequests).where(where),
      params,
    );
    return {
      helpRequests: result.data.map((r) => ({
        ...serializeHelpRequest(r.request),
        botName: r.bot.displayName,
        canAnswer: r.request.status === "pending" && canAnswerHelp(r.bot, tags),
      })),
      pagination: result.pagination,
    };
  }
}
