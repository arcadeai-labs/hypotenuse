import { and, eq } from "drizzle-orm";
import type { Bot } from "../schema/bots";
import {
  type ChannelBinding,
  channelBindings,
} from "../schema/channel_bindings";
import { type Channel, channels } from "../schema/channels";
import type { Tag } from "../schema/tags";
import { assertCanWriteBot, loadReadableBot } from "./BotOps";
import { bindingNotFound } from "./ChannelOps";
import type { DbHandle } from "./DbOps";

/**
 * Load a binding a person is about to change: locked, in the project, of a
 * bot they may read (else the same 404 as a missing one), and refused unless
 * they may write the bot.
 * @param tx - An open transaction.
 * @param projectId - The project.
 * @param bindingId - The binding.
 * @param callerTags - The caller's tags.
 * @returns The binding, its bot, and its channel.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`, or the write refusal.
 */
export async function loadWritableBinding(
  tx: DbHandle,
  projectId: number,
  bindingId: number,
  callerTags: Tag[],
): Promise<{ binding: ChannelBinding; bot: Bot; channel: Channel }> {
  const [row] = await tx
    .select({ binding: channelBindings, channel: channels })
    .from(channelBindings)
    .innerJoin(channels, eq(channels.id, channelBindings.channelId))
    .where(
      and(
        eq(channelBindings.id, bindingId),
        eq(channelBindings.projectId, projectId),
      ),
    )
    .for("update", { of: channelBindings })
    .limit(1);
  if (!row) throw bindingNotFound();
  const bot = await loadReadableBot(
    tx,
    projectId,
    row.binding.botId,
    callerTags,
  ).catch(() => {
    throw bindingNotFound();
  });
  assertCanWriteBot(bot, callerTags);
  return { ...row, bot };
}
