import { eq } from "drizzle-orm";
import {
  api,
  Channel,
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../middleware/session";
import { RUNNER_CHANNEL_PATTERN } from "../ops/RunnerOps";
import { runners } from "../schema/runners";

/**
 * The subscribe-time gate on `runner:<id>`: the session must be one
 * `daemon:connect` minted for **this** runner, and the runner must not be
 * revoked. A person's session — even the owner's — never qualifies: the
 * channel wakes a machine, and nothing on it is for a person.
 *
 * The row is re-read on every subscribe because a socket's session is held in
 * memory: deleting it from Redis at revocation stops it being presented
 * again, and this check stops the socket that already holds it.
 */
export const RunnerChannelMiddleware: ChannelMiddleware = {
  runBefore: async (channelName: string, connection: Connection) => {
    const runnerId = (connection as Connection<SessionImpl>).session?.data
      .runnerId;
    const match = RUNNER_CHANNEL_PATTERN.exec(channelName);
    const channelRunnerId = match ? Number(match[1]) : Number.NaN;
    if (!runnerId || runnerId !== channelRunnerId) {
      throw new TypedError({
        message: "Only this runner's daemon can subscribe to its channel",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    const [row] = await api.db.db
      .select({ status: runners.status })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1);
    if (!row || row.status === "revoked") {
      throw new TypedError({
        message: "This runner is revoked",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};

/**
 * `runner:<runnerId>` — a runner's doorbell. Frames are content-free
 * (`{ event: "work" | "cancel" | "revoked" }`) and the daemon answers `work`
 * and `cancel` by heartbeating, where offers and cancels are actually read,
 * so a frame lost, duplicated, or delivered to a stale socket costs nothing.
 *
 * The presence key is the channel itself, so `api.channels.members("runner:5")`
 * answers "is a socket attached" across the cluster.
 *
 * A daemon subscribes once per socket and never unsubscribes — it closes and
 * reconnects instead. That is a property of its design: Keryx before 0.48.1
 * applied one socket's subscribe and unsubscribe frames out of order
 * (actionhero/keryx#550), and a socket that never unsubscribes never depended
 * on the fix.
 */
export class RunnerChannel extends Channel {
  constructor() {
    super({
      name: RUNNER_CHANNEL_PATTERN,
      description:
        "A runner's wake-up channel. Only the session daemon:connect minted for that runner may subscribe.",
      middleware: [RunnerChannelMiddleware],
    });
  }

  /**
   * One presence key per runner, whatever the connection.
   * @param connection - The subscribing connection.
   * @returns `runner:<id>`.
   */
  async presenceKey(connection: Connection): Promise<string> {
    const runnerId = (connection as Connection<SessionImpl>).session?.data
      .runnerId;
    return runnerId ? `runner:${runnerId}` : connection.id;
  }
}
