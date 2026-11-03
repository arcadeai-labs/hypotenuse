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
import { canReadBot } from "../ops/BotOps";
import { BOT_DASHBOARD_CHANNEL_PATTERN } from "../ops/DashboardEffectsOps";
import { MAX_ID } from "../ops/InputOps";
import { resolveProjectAccess } from "../ops/MembershipOps";
import { bots } from "../schema/bots";

/**
 * The subscribe-time gate on `project:<id>:bot:<id>:dashboard`. The channel
 * name is client-supplied, so this is the whole of its access control: a
 * session, member standing in the project, and `canReadBot` on the named bot
 * — the rule every dashboard list filters by. Every refusal past the session
 * check is the same, so a subscription cannot probe which bots exist.
 */
export const BotDashboardChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const userId = (connection as Connection<SessionImpl>).session?.data.userId;
    if (!userId) {
      throw new TypedError({
        message: "Sign in before subscribing to a bot's activity",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
    const refuse = () =>
      new TypedError({
        message: "You may not follow this bot",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    const match = BOT_DASHBOARD_CHANNEL_PATTERN.exec(channelName);
    const projectId = match ? Number(match[1]) : Number.NaN;
    const botId = match ? Number(match[2]) : Number.NaN;
    for (const id of [projectId, botId]) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) throw refuse();
    }
    const access = await resolveProjectAccess(userId, projectId);
    if (!access) throw refuse();
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.projectId, projectId)))
      .limit(1);
    if (!bot || !canReadBot(bot, access.callerTags)) throw refuse();
  },
};

/**
 * `project:<projectId>:bot:<botId>:dashboard` — the live half of the
 * dashboard's lists. **Every frame is `{ event: "dashboard", stale }`**, where
 * `stale` is `conversations`, `inbox`, or `sandboxes`: which read to repeat,
 * nothing more (`DashboardEffectsOps`).
 */
export class BotDashboardChannel extends Channel {
  constructor() {
    super({
      name: BOT_DASHBOARD_CHANNEL_PATTERN,
      description:
        "Live pings for one bot's conversations, inbox items, and sandbox jobs: content-free frames naming which list to re-read. Requires a session, member standing in the project, and read access to the bot.",
      middleware: [BotDashboardChannelMiddleware],
    });
  }
}
