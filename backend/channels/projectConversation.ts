import {
  api,
  Channel,
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../middleware/session";
import {
  CONVERSATION_CHANNEL_PATTERN,
  loadReadableConversation,
} from "../ops/ConversationOps";
import { MAX_ID } from "../ops/InputOps";
import { resolveProjectAccess } from "../ops/MembershipOps";

/**
 * The subscribe-time gate on `project:<id>:conversation:<id>`. The channel
 * name is client-supplied, so this is the whole of its access control: a
 * session, member standing in the project, and read access to the
 * conversation's bot — the same rule `conversation:entries` applies. Every
 * refusal past the session check is the same, so a subscription cannot probe
 * which conversations exist.
 */
export const ProjectConversationChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const userId = (connection as Connection<SessionImpl>).session?.data.userId;
    if (!userId) {
      throw new TypedError({
        message: "Sign in before subscribing to a conversation",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
    const refuse = () =>
      new TypedError({
        message: "You may not follow this conversation",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    const match = CONVERSATION_CHANNEL_PATTERN.exec(channelName);
    const projectId = match ? Number(match[1]) : Number.NaN;
    const conversationId = match ? Number(match[2]) : Number.NaN;
    for (const id of [projectId, conversationId]) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) throw refuse();
    }
    const access = await resolveProjectAccess(userId, projectId);
    if (!access) throw refuse();
    try {
      await loadReadableConversation(
        api.db.db,
        projectId,
        conversationId,
        access.callerTags,
      );
    } catch {
      throw refuse();
    }
  },
};

/**
 * `project:<projectId>:conversation:<conversationId>` — the live half of a
 * transcript. **Every frame is exactly `{ "event": "conversation" }`**: it
 * says something changed, and the page re-reads `conversation:entries` since
 * its last seq. Ticks publish through Keryx's Redis-backed PubSub, so a step
 * a worker takes reaches a socket the web service holds.
 */
export class ProjectConversationChannel extends Channel {
  constructor() {
    super({
      name: CONVERSATION_CHANNEL_PATTERN,
      description:
        "Live pings for one conversation's transcript: content-free frames that say to re-read. Requires a session, member standing in the project, and read access to the bot.",
      middleware: [ProjectConversationChannelMiddleware],
    });
  }
}
