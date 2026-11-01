import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { serializeSandboxJob } from "../../ops/SandboxJobOps";
import { bots } from "../../schema/bots";
import { SANDBOX_JOB_STATUSES, sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * `sandbox-job:list` — a project's sandbox jobs, newest first, of the bots
 * the caller may read. A job of an unreadable bot is absent, and the total
 * counts only readable ones.
 */
export class SandboxJobList implements Action {
  name = "sandbox-job:list";
  description =
    "List a project's sandbox jobs — code work bots handed to a coding agent — newest first, with each one's bot, status, title, and token usage. Only jobs of bots you may read are listed. Filter by botId, conversationId, or status. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/sandbox-jobs", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    botId: idInput("Only this bot's jobs").optional(),
    conversationId: idInput("Only jobs this conversation started").optional(),
    status: z
      .enum(SANDBOX_JOB_STATUSES)
      .optional()
      .describe("Only jobs in this status"),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @param connection - The caller's connection.
   * @returns The jobs, each with its bot, and pagination.
   */
  async run(
    params: ActionParams<SandboxJobList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const botIds = await readableIds(
      api.db.db,
      BOT_ACCESS_LIST,
      params.projectId,
      connection.metadata.callerTags ?? [],
    );
    const where = and(
      eq(sandboxJobs.projectId, params.projectId),
      inArray(sandboxJobs.botId, botIds),
      params.botId ? eq(sandboxJobs.botId, params.botId) : undefined,
      params.conversationId
        ? eq(sandboxJobs.parentConversationId, params.conversationId)
        : undefined,
      params.status ? eq(sandboxJobs.status, params.status) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select({ job: sandboxJobs, botName: bots.name, botSlug: bots.slug })
        .from(sandboxJobs)
        .innerJoin(bots, eq(bots.id, sandboxJobs.botId))
        .where(where)
        .orderBy(desc(sandboxJobs.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(sandboxJobs).where(where),
      params,
    );
    return {
      sandboxJobs: result.data.map((row) => ({
        ...serializeSandboxJob(row.job),
        bot: { id: row.job.botId, name: row.botName, slug: row.botSlug },
      })),
      pagination: result.pagination,
    };
  }
}
