import { and, eq, inArray } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
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
import {
  INBOX_KINDS,
  readInbox,
  serializeInboxItem,
} from "../../ops/DashboardOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";

/**
 * `inbox:list` — everything in a project waiting on a person, in one list:
 * pending tool-call approvals, help requests, and questions a sandbox job
 * asked its conversation. Only the bots the caller may read; each item says
 * whether the caller may answer it, by the rule its own action applies. An
 * item is answered through that action (`approval:decide`, `help:answer`,
 * `sandbox-job:answer`), the same operation a platform's button runs.
 */
export class InboxList implements Action {
  name = "inbox:list";
  description =
    "List what is waiting on a person in a project, newest first: pending approvals (kind approval: a bot wants to call server/tool), help requests (kind help: a bot escalated a question), and questions a sandbox job asked (kind sandbox-question). Each item names its bot, conversation, and job, and says whether you may answer it (canAnswer). Answer with approval:decide, help:answer, or sandbox-job:answer. Only bots you may read. Filter by kind or botId. Requires membership. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/inbox", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    kind: z
      .enum(INBOX_KINDS)
      .optional()
      .describe("Only this kind: approval, help, or sandbox-question"),
    botId: idInput("Only this bot's items").optional(),
  });

  /**
   * @param params - The project, filters, and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The items and pagination.
   */
  async run(
    params: ActionParams<InboxList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const db = api.db.db;
    const botIds = await readableIds(
      db,
      BOT_ACCESS_LIST,
      params.projectId,
      callerTags,
    );
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const { rows, total } = await readInbox(db, {
      projectId: params.projectId,
      botIds,
      kinds: params.kind ? [params.kind] : [...INBOX_KINDS],
      botId: params.botId,
      limit,
      offset: (page - 1) * limit,
    });
    const ids = [...new Set(rows.map((r) => Number(r.bot_id)))];
    const botRows = ids.length
      ? await db
          .select()
          .from(bots)
          .where(
            and(eq(bots.projectId, params.projectId), inArray(bots.id, ids)),
          )
      : [];
    const byId = new Map(botRows.map((b) => [b.id, b]));
    return {
      items: rows.flatMap((row) => {
        const bot = byId.get(Number(row.bot_id));
        return bot ? [serializeInboxItem(row, bot, callerTags)] : [];
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}
