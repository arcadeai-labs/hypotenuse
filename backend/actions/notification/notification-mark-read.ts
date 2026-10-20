import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import type { SessionImpl } from "../../middleware/session";
import { SessionMiddleware } from "../../middleware/session";
import { unreadCount } from "../../ops/NotificationOps";
import { notifications } from "../../schema/notifications";

/**
 * `notification:mark-read` — clear the badge.
 *
 * A person's own MCP client can call this, the same way the UI can. A runner
 * token cannot: it may reach only `daemon:*` actions, so a coding agent can
 * never silence the inbox of the person it works for.
 *
 * Not an `AuditedAction` either: read state is a per-person UI preference, not a
 * change to the project, and a row per notification opened would bury the
 * project's actual change history.
 *
 * The `userId` in the `WHERE` clause comes from the session, so ids belonging to
 * somebody else simply match nothing. That is a silent no-op by design rather
 * than a 403 — telling a caller which of their guessed ids exist is an oracle,
 * and the honest answer is in the returned `updated` count.
 */
export class NotificationMarkRead implements Action {
  name = "notification:mark-read";
  description =
    "Mark your own in-app notifications as read, either by id or all at once. Only ever affects the calling user's notifications.";
  mcp = { tool: false };
  middleware = [SessionMiddleware];
  web = { route: "/notifications/read", method: HTTP_METHOD.POST };
  inputs = z.object({
    notificationIds: z
      .array(z.coerce.number().int().positive())
      .max(500)
      .optional()
      .describe("The notifications to mark read"),
    all: z
      .boolean()
      .optional()
      .describe("Mark every unread notification of yours as read"),
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("With `all`, limit the sweep to one project"),
  });

  /**
   * @param params - Explicit ids, or `all: true` with an optional project.
   * @param connection - The caller's session; its `userId` scopes the update.
   * @returns How many rows were marked, and the caller's new unread count.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` (406) when neither
   *   `notificationIds` nor `all` is supplied.
   */
  async run(
    params: ActionParams<NotificationMarkRead>,
    connection: Connection<SessionImpl>,
  ) {
    const userId = connection.session?.data.userId as number;

    if (!params.all && (params.notificationIds ?? []).length === 0) {
      throw new TypedError({
        message: "Supply notificationIds, or all: true",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "notificationIds",
      });
    }

    const updated = await api.db.db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          // Always first, and never from a param: this is the whole
          // authorization model for the notification family.
          eq(notifications.userId, userId),
          eq(notifications.channel, "browser"),
          isNull(notifications.readAt),
          params.all
            ? params.projectId
              ? eq(notifications.projectId, params.projectId)
              : undefined
            : inArray(notifications.id, params.notificationIds ?? []),
        ),
      )
      .returning({ id: notifications.id });

    return {
      updated: updated.length,
      unread: await unreadCount(userId, params.projectId),
    };
  }
}
