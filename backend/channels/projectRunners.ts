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
import { PROJECT_RUNNERS_CHANNEL_PATTERN } from "../ops/RunnerOps";
import { projectMemberships } from "../schema/project_memberships";

/**
 * The subscribe-time gate on `project:<id>:runners`: a signed-in person who
 * is a member of the project. The same refusal whether the project exists or
 * not, so the channel does not enumerate project ids.
 */
export const ProjectRunnersChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const userId = (connection as Connection<SessionImpl>).session?.data.userId;
    if (!userId) {
      throw new TypedError({
        message: "Sign in before subscribing to runners",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
    const match = PROJECT_RUNNERS_CHANNEL_PATTERN.exec(channelName);
    const projectId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new TypedError({
        message: `Not a runners channel: ${channelName}`,
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
    if (!membership) {
      throw new TypedError({
        message: "You are not a member of this project",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};

/**
 * `project:<projectId>:runners` — tells a project's dashboards that its
 * runner list changed: a registration, an edit, a revocation, a heartbeat
 * that changed status or capabilities, or the reaper. The one frame,
 * `{ event: "runners" }`, carries no ids; the list is visible to every member
 * anyway, and the client re-reads it through `runner:list`.
 */
export class ProjectRunnersChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_RUNNERS_CHANNEL_PATTERN,
      description:
        "Live changes to one project's runner list. Requires a session and membership in that project.",
      middleware: [ProjectRunnersChannelMiddleware],
    });
  }
}
