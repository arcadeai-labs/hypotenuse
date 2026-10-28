import {
  Channel,
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../middleware/session";
import { resolveProjectAccess } from "../ops/MembershipOps";
import { PROJECT_NOTIFICATIONS_CHANNEL_PATTERN } from "../ops/NotificationOps";

/**
 * The subscribe-time gate on `project:<id>:notifications`.
 *
 * **The highest-risk code in the notification path**, because the channel name
 * is client-supplied: without this check any signed-in user could subscribe to
 * another tenant's project and learn when its people are being told something.
 * The frames carry no content, but timing is still information, and there is no
 * second gate behind this one.
 *
 * The rule is the `member` level, through the same `resolveProjectAccess` the
 * RBAC middleware uses: a project membership, or owning the project's
 * organization. The refusal is the same whether the project exists or not.
 */
export const ProjectNotificationsChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const userId = (connection as Connection<SessionImpl>).session?.data.userId;
    if (!userId) {
      throw new TypedError({
        message: "Sign in before subscribing to notifications",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }

    // Keryx routes only names its pattern matched, so this is unreachable
    // through the regular path — which is why it must refuse rather than crash
    // on `Number(undefined)` if that ever changes.
    const match = PROJECT_NOTIFICATIONS_CHANNEL_PATTERN.exec(channelName);
    const projectId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new TypedError({
        message: `Not a notifications channel: ${channelName}`,
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }

    if (!(await resolveProjectAccess(userId, projectId))) {
      throw new TypedError({
        message: "You are not a member of this project",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};

/**
 * `project:<projectId>:notifications` — the live half of notifications.
 *
 * **One channel per project, and every frame is exactly
 * `{ "event": "notifications" }`** — no id, no recipient. A frame says only that
 * something changed; the client re-reads through `notification:list`, which is
 * scoped to its own session. Broadcasts travel over Keryx's Redis-backed PubSub,
 * so a notification the worker dispatches reaches a socket the web service holds.
 */
export class ProjectNotificationsChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_NOTIFICATIONS_CHANNEL_PATTERN,
      description:
        "Live notification pings for one project: content-free frames that say to re-read. Requires a session and member standing in that project.",
      middleware: [ProjectNotificationsChannelMiddleware],
    });
  }
}
