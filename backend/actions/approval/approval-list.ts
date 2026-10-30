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
import { canDecide, serializeApproval } from "../../ops/ApprovalOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { APPROVAL_STATUSES, approvals } from "../../schema/approvals";
import { bots } from "../../schema/bots";

/**
 * `approval:list` — a project's tool-call approvals, newest first, for the
 * bots the caller may read. Requires membership.
 */
export class ApprovalList implements Action {
  name = "approval:list";
  description =
    "List tool-call approvals in a project, newest first: which bot wants to call which server/tool with which (scrubbed) arguments, in which conversation, and where each stands (pending, approved, denied, expired, consumed). Only bots you may read. Filter by status, bot, or conversation. Each says whether you may decide it. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/approvals", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    status: z
      .enum(APPROVAL_STATUSES)
      .optional()
      .describe("Only approvals in this status, e.g. pending"),
    botId: idInput("Only this bot's approvals").optional(),
    conversationId: idInput("Only this conversation's approvals").optional(),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The approvals and pagination metadata.
   */
  async run(params: ActionParams<ApprovalList>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const botIds = await readableIds(
      api.db.db,
      BOT_ACCESS_LIST,
      params.projectId,
      tags,
    );
    const where = and(
      eq(approvals.projectId, params.projectId),
      inArray(approvals.botId, botIds.length ? botIds : [-1]),
      params.status ? eq(approvals.status, params.status) : undefined,
      params.botId ? eq(approvals.botId, params.botId) : undefined,
      params.conversationId
        ? eq(approvals.conversationId, params.conversationId)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({ approval: approvals, bot: bots })
        .from(approvals)
        .innerJoin(bots, eq(bots.id, approvals.botId))
        .where(where)
        .orderBy(desc(approvals.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(approvals).where(where),
      params,
    );
    return {
      approvals: result.data.map((r) => ({
        ...serializeApproval(r.approval),
        botName: r.bot.displayName,
        canDecide: canDecide(r.bot, tags),
      })),
      pagination: result.pagination,
    };
  }
}
