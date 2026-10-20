import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import type { SessionImpl } from "../../middleware/session";
import { SessionMiddleware } from "../../middleware/session";
import { serializeNotification } from "../../ops/NotificationOps";
import { notifications } from "../../schema/notifications";

/**
 * `notification:list` — the caller's own inbox.
 *
 * **Not project-scoped middleware, and that is the design rather than an
 * omission.** A notification belongs to a *user*: the bell spans every project
 * they are in, and a member who was removed from a project still has the rows
 * they were sent while they were in it. So the gate is a session, and the
 * `userId` every query filters on comes from that session and **never** from a
 * param. There is no `userId` input to supply.
 *
 * `browser` rows only. An `email` row is a delivery record, not an inbox item —
 * it has no `readAt` anybody sets, so listing it would show the same event
 * twice with one copy permanently unread.
 *
 * **An MCP tool.** "Do I have anything unread?" is a reasonable thing to ask
 * your own Claude, and the answer is scoped to the asker by construction.
 */
export class NotificationList implements Action {
  name = "notification:list";
  description =
    "List your own in-app notifications, most recent first, optionally only the unread ones. Always scoped to the calling user — there is no way to read anyone else's.";
  mcp = { tool: true };
  middleware = [SessionMiddleware];
  web = { route: "/notifications", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only notifications from this project"),
    unreadOnly: z
      .stringbool()
      .optional()
      .describe("Only notifications you have not read yet"),
  });

  /**
   * @param params - Optional project filter and unread filter, plus pagination.
   * @param connection - The caller's session; its `userId` scopes every row.
   * @returns This page of the caller's notifications, plus pagination metadata.
   */
  async run(
    params: ActionParams<NotificationList>,
    connection: Connection<SessionImpl>,
  ) {
    const userId = connection.session?.data.userId as number;

    const where = and(
      eq(notifications.userId, userId),
      eq(notifications.channel, "browser"),
      params.projectId
        ? eq(notifications.projectId, params.projectId)
        : undefined,
      params.unreadOnly ? isNull(notifications.readAt) : undefined,
    );

    const result = await paginate(
      api.db.db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(notifications).where(where),
      params,
    );

    return {
      notifications: result.data.map((row) => serializeNotification(row)),
      pagination: result.pagination,
    };
  }
}
