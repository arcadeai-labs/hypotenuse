import { eq } from "drizzle-orm";
import { botInstallations } from "../schema/bot_installations";
import type { Channel } from "../schema/channels";
import type { Conversation } from "../schema/conversations";
import type { DbHandle } from "./DbOps";

/**
 * Where a conversation lives on its platform, for the dashboard's "open in"
 * link. Built only from ids the platform gave us — never from text a
 * participant wrote — so a link can only ever point at the platform.
 *
 * | Platform | Link |
 * |---|---|
 * | `slack` | `https://app.slack.com/client/<team>/<channel>/thread/<channel>-<thread ts>` (the channel when there is no thread) |
 * | `linear` | the agent session's URL Linear sent, else its issue's URL |
 * | `pylon` | the issue's link Pylon sent |
 * | anything else (`web`, `api`, `webhook`) | `null` — the dashboard is where it lives |
 *
 * @param db - A database handle.
 * @param conversation - The conversation.
 * @param channel - Its channel.
 * @returns An `https:` URL, or `null`.
 */
export async function conversationUrl(
  db: DbHandle,
  conversation: Conversation,
  channel: Channel,
): Promise<string | null> {
  const details = (conversation.details ?? {}) as Record<string, unknown>;
  if (channel.type === "linear") {
    return httpsOrNull(details.sessionUrl) ?? httpsOrNull(details.issueUrl);
  }
  if (channel.type === "pylon") return httpsOrNull(details.link);
  if (channel.type === "slack") {
    if (!channel.botInstallationId) return null;
    const [inst] = await db
      .select({ team: botInstallations.externalWorkspaceId })
      .from(botInstallations)
      .where(eq(botInstallations.id, channel.botInstallationId))
      .limit(1);
    if (!inst) return null;
    return slackUrl(
      inst.team,
      channel.externalId,
      conversation.externalConversationKey,
    );
  }
  return null;
}

/**
 * A Slack web-client link to a channel or a thread in it.
 * @param team - The workspace id (`T…`).
 * @param channelId - The channel id.
 * @param threadTs - The thread's root `ts`, if any.
 * @returns The URL, or `null` when an id is not one Slack issues.
 */
export function slackUrl(
  team: string,
  channelId: string,
  threadTs: string | null,
): string | null {
  const id = /^[A-Z0-9]+$/;
  if (!id.test(team) || !id.test(channelId)) return null;
  const base = `https://app.slack.com/client/${team}/${channelId}`;
  if (threadTs && /^\d+\.\d+$/.test(threadTs)) {
    return `${base}/thread/${channelId}-${threadTs}`;
  }
  return base;
}

/**
 * A value that is an `https:` URL, else `null`.
 * @param value - Anything a platform sent.
 * @returns The URL, or `null`.
 */
function httpsOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
