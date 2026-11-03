import { and, asc, eq, inArray } from "drizzle-orm";
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
import { readableIds } from "../../ops/AccessOps";
import { BOT_ACCESS_LIST } from "../../ops/BotOps";
import {
  countConversations,
  countInbox,
  emptyCounts,
  memorySizes,
  recentConversations,
  serializeOverviewBot,
  spendToday,
  startOfUtcDay,
} from "../../ops/DashboardOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";

/**
 * `project:overview` — mission control in one read: every bot the caller may
 * read with its live counts by conversation state (waiting split by what it
 * waits on), what ended today, today's model spend, and what is waiting on a
 * person; the inbox totals; and the conversations that changed most
 * recently. A bot the caller may not read is absent from every number.
 */
export class ProjectOverview implements Action {
  name = "project:overview";
  description =
    "What a project's bots are doing right now: for each bot you may read, how many conversations are working, hibernating, and waiting (split by what they wait on: answer, approval, help, sandbox, timer), how many ended today (UTC), today's model spend in USD, and how many inbox items wait on a person, and how many channel memories it has where it works; the inbox totals by kind; and the most recently changed conversations. Bots you may not read are left out of every count. Requires membership.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/overview", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: idInput("The project"),
    recent: z.coerce
      .number()
      .int()
      .min(0)
      .max(50)
      .default(10)
      .describe("How many recently changed conversations to include (0–50)"),
  });

  /**
   * @param params - The project and the feed's length.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The bots with their counts, the inbox totals, and the feed.
   */
  async run(
    params: ActionParams<ProjectOverview>,
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
    const since = startOfUtcDay();
    const rows = botIds.length
      ? await db
          .select()
          .from(bots)
          .where(
            and(eq(bots.projectId, params.projectId), inArray(bots.id, botIds)),
          )
          .orderBy(asc(bots.name))
      : [];
    const [counts, spend, inbox, recent, memory] = await Promise.all([
      countConversations(db, params.projectId, botIds, since),
      spendToday(db, params.projectId, botIds, since),
      countInbox(db, params.projectId, botIds),
      recentConversations(db, params.projectId, botIds, params.recent),
      memorySizes(db, params.projectId, botIds),
    ]);
    const total = emptyCounts();
    let usd = 0;
    let unpriced = 0;
    const out = rows.map((bot) => {
      const c = counts.get(bot.id) ?? emptyCounts();
      const s = spend.get(bot.id) ?? { usd: 0, unpriced: 0 };
      total.working += c.working;
      total.hibernating += c.hibernating;
      total.waitingTotal += c.waitingTotal;
      total.endedToday += c.endedToday;
      for (const k of Object.keys(c.waiting) as (keyof typeof c.waiting)[]) {
        total.waiting[k] += c.waiting[k];
      }
      usd += s.usd;
      unpriced += s.unpriced;
      return {
        ...serializeOverviewBot(bot, callerTags),
        counts: c,
        spendToday: { usd: s.usd, unpricedRecords: s.unpriced },
        needsPerson: inbox.byBot.get(bot.id) ?? 0,
        memoryDocuments: memory.get(bot.id) ?? 0,
      };
    });
    return {
      overview: {
        since: since.getTime(),
        bots: out,
        totals: {
          counts: total,
          spendToday: { usd, unpricedRecords: unpriced },
        },
        inbox: {
          ...inbox.byKind,
          total:
            inbox.byKind.approval +
            inbox.byKind.help +
            inbox.byKind["sandbox-question"],
        },
        recent,
      },
    };
  }
}
