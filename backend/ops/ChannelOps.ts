import { and, eq } from "drizzle-orm";
import {
  api,
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../middleware/session";
import { projectMemberships } from "../schema/project_memberships";

/**
 * The subscribe-time gate every `project:<id>:<noun>` dashboard channel
 * shares: a signed-in person who is a member of the project. Deny by
 * default, and the same refusal whether the project exists or not, so a
 * channel never enumerates project ids. The channel name is client-supplied;
 * this is the only gate in front of a broadcast.
 * @param pattern - The channel's name pattern; group 1 is the project id.
 * @param noun - What the channel carries, for the refusal messages.
 * @returns The middleware.
 */
export function projectMemberChannelMiddleware(
  pattern: RegExp,
  noun: string,
): ChannelMiddleware {
  return {
    runBefore: async (channelName: string, connection: Connection) => {
      const userId = (connection as Connection<SessionImpl>).session?.data
        .userId;
      if (!userId) {
        throw new TypedError({
          message: `Sign in before subscribing to ${noun}`,
          type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
        });
      }
      const match = pattern.exec(channelName);
      const projectId = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        throw new TypedError({
          message: `Not a ${noun} channel: ${channelName}`,
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
}
