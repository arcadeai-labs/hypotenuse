import { and, eq } from "drizzle-orm";
import {
  api,
  Channel,
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../middleware/session";
import { PROJECT_NOTIFICATIONS_CHANNEL_PATTERN } from "../ops/NotificationOps";
import { projectMemberships } from "../schema/project_memberships";

/**
 * The subscribe-time gate on `project:<id>:notifications`.
 *
 * **This is the highest-risk code in the notification path**, because the
 * channel name is client-supplied: without the membership check any
 * authenticated user could subscribe to `project:7:notifications` and learn
 * when another tenant's people are being told something. The frames carry no
 * content, but timing is still information, and there is no second gate behind
 * this one — a broadcast goes to whoever is subscribed.
 *
 * A `ChannelMiddleware`, which is a **different type** from the action
 * middleware everywhere else here: its `runBefore` takes the channel name and
 * the connection, not params, and it runs at subscribe time rather than per
 * action. Throwing is how a subscription is refused; Keryx catches it and
 * answers the socket with an error instead of adding the subscription.
 */
export const ProjectNotificationsChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const conn = connection as Connection<SessionImpl>;
    const userId = conn.session?.data.userId;

    if (!userId) {
      throw new TypedError({
        message: "Sign in before subscribing to notifications",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }

    // A name that does not parse is refused rather than throwing a `TypeError`
    // out of `Number(undefined)`. Keryx only routes names its pattern already
    // matched, so this is unreachable through the regular path — which is
    // exactly why it must not be an unhandled crash if that ever changes.
    const match = PROJECT_NOTIFICATIONS_CHANNEL_PATTERN.exec(channelName);
    const projectId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new TypedError({
        message: `Not a notifications channel: ${channelName}`,
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }

    const [membership] = await api.db.db
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, userId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .limit(1);

    // The same message a non-member gets from `ProjectMemberMiddleware`, and
    // deliberately the same whether the project exists or not: otherwise this
    // endpoint enumerates project ids to anyone with a session.
    if (!membership) {
      throw new TypedError({
        message: "You are not a member of this project",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};

/**
 * `project:<projectId>:notifications` — the real-time half of the notification
 * system.
 *
 * **One channel per project, and the frames on it carry no content** — exactly
 * `{ "event": "notifications" }`, with no id and no recipient. That is what
 * makes one shared channel safe: a frame says only that something changed, and
 * the client re-reads through `notification:list`, which is scoped to its own
 * session. Anything that must respect who is asking travels on a path that
 * checks.
 *
 * Broadcasts reach it through Keryx's Redis-backed PubSub, which is what makes
 * the deployed topology work at all: the **worker** dispatches notifications and
 * the **web service** holds the sockets, and in that arrangement they are never
 * the same process.
 */
export class ProjectNotificationsChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_NOTIFICATIONS_CHANNEL_PATTERN,
      description:
        "Live notifications for one project. Requires a session and membership in that project.",
      middleware: [ProjectNotificationsChannelMiddleware],
    });
  }
}
