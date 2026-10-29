import { type Action, type ActionParams, Connection, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { SessionImpl } from "../../middleware/session";
import { SessionMiddleware } from "../../middleware/session";
import { unreadCount } from "../../ops/NotificationOps";

/**
 * `notification:unread-count` — the number on the bell.
 *
 * Its own action rather than a field on `notification:list`, because of how
 * often it is asked: every page load, and again on every live ping and
 * reconnect, whether or not anything is on screen. The socket is an
 * accelerant — a socket that dies silently is the normal failure mode and a
 * stale badge is the symptom nobody reports — so this has to be one index
 * scan and nothing else. Reconnect is the safety net that used to be a
 * sixty-second timer.
 *
 * Scoped to the session's user, like everything else in this family. There is no
 * `userId` param to pass.
 */
export class NotificationUnreadCount implements Action {
  name = "notification:unread-count";
  description =
    "How many of your own in-app notifications you have not read yet, optionally within one project. Always scoped to the calling user.";
  mcp = { tool: true };
  middleware = [SessionMiddleware];
  web = { route: "/notifications/unread-count", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Count only notifications from this project"),
  });

  /**
   * @param params - An optional project filter.
   * @param connection - The caller's session; its `userId` scopes the count.
   * @returns `{ count }`.
   */
  async run(
    params: ActionParams<NotificationUnreadCount>,
    connection: Connection<SessionImpl>,
  ) {
    const userId = connection.session?.data.userId as number;
    return { count: await unreadCount(userId, params.projectId) };
  }
}
