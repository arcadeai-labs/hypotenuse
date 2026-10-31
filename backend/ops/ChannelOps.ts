import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import type { ChannelRef } from "../platforms/types";
import type { BotInstallation } from "../schema/bot_installations";
import type { Bot } from "../schema/bots";
import {
  APPROVAL_POLICIES,
  BINDING_MODES,
  type ChannelBinding,
  channelBindings,
} from "../schema/channel_bindings";
import { type Channel, channels } from "../schema/channels";
import { type Participant, participants } from "../schema/participants";
import type { DbHandle } from "./DbOps";

/**
 * Channels, the participants who write in them, and the bindings that let a
 * bot listen there.
 */

/**
 * A platform channel's `externalId`: the workspace and the platform's own id,
 * so two workspaces' channels never collide within a project.
 * @param workspace - The installation's `externalWorkspaceId`.
 * @param channelId - The platform's channel id.
 * @returns The key.
 */
export function platformChannelKey(workspace: string, channelId: string) {
  return `${workspace}/${channelId}`;
}

/**
 * Find or create a platform channel, refreshing what the platform says about
 * it (name, private, shared). `INSERT … ON CONFLICT DO NOTHING`, then read,
 * so a replayed event is an upsert.
 * @param tx - An open transaction.
 * @param installation - The installation that saw it.
 * @param ref - The channel as the platform describes it.
 * @returns The channel.
 */
export async function upsertPlatformChannel(
  tx: DbHandle,
  installation: BotInstallation,
  ref: ChannelRef,
): Promise<Channel> {
  const externalId = platformChannelKey(
    installation.externalWorkspaceId,
    ref.externalId,
  );
  const values = {
    name: ref.name,
    isPrivate: ref.isPrivate,
    isShared: ref.isShared,
    parentExternalId: ref.parentExternalId ?? null,
  };
  const [row] = await tx
    .insert(channels)
    .values({
      projectId: installation.projectId,
      type: installation.type,
      externalId,
      botInstallationId: installation.id,
      ...values,
    })
    .onConflictDoUpdate({
      target: [channels.projectId, channels.type, channels.externalId],
      set: values,
    })
    .returning();
  return row;
}

/**
 * Find or create a bot's dashboard (`web`) channel. `fresh` mints a scratch
 * channel — a memory boundary with nothing in it.
 * @param tx - An open transaction.
 * @param bot - The bot.
 * @param fresh - A new scratch channel instead of the shared `dashboard`.
 * @returns The channel.
 */
export async function upsertWebChannel(
  tx: DbHandle,
  bot: Bot,
  fresh: boolean,
): Promise<Channel> {
  const key = fresh ? `scratch-${randomBytes(4).toString("hex")}` : "dashboard";
  const externalId = `bot:${bot.id}:${key}`;
  await tx
    .insert(channels)
    .values({
      projectId: bot.projectId,
      type: "web",
      externalId,
      botId: bot.id,
      name: key,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.projectId, bot.projectId),
        eq(channels.type, "web"),
        eq(channels.externalId, externalId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Record a platform person, refreshing their name and when they were last seen.
 * @param tx - An open transaction.
 * @param installation - Where they wrote.
 * @param sender - Who they are on the platform.
 * @returns The participant.
 */
export async function upsertParticipant(
  tx: DbHandle,
  installation: BotInstallation,
  sender: { externalUserId: string; displayName: string; isBot: boolean },
): Promise<Participant> {
  const [row] = await tx
    .insert(participants)
    .values({
      projectId: installation.projectId,
      type: installation.type,
      externalWorkspaceId: installation.externalWorkspaceId,
      externalUserId: sender.externalUserId,
      displayName: sender.displayName,
      isBot: sender.isBot,
    })
    .onConflictDoUpdate({
      target: [
        participants.projectId,
        participants.type,
        participants.externalWorkspaceId,
        participants.externalUserId,
      ],
      set: { displayName: sender.displayName, lastSeenAt: sql`now()` },
    })
    .returning();
  return row;
}

/**
 * Whether a bot binds itself in a channel of this kind.
 * @param bot - The bot.
 * @param ref - The channel.
 * @returns The bot's `autoBind` for a DM, a private, or a public channel.
 */
export function autoBinds(
  bot: Pick<Bot, "autoBind">,
  ref: Pick<ChannelRef, "isDm" | "isPrivate">,
): boolean {
  if (ref.isDm) return bot.autoBind.dm;
  if (ref.isPrivate) return bot.autoBind.private;
  return bot.autoBind.public;
}

/**
 * A bot's binding in a channel.
 * @param db - A database handle.
 * @param botId - The bot.
 * @param channelId - The channel.
 * @returns The binding, or `undefined`.
 */
export async function bindingFor(
  db: DbHandle,
  botId: number,
  channelId: number,
): Promise<ChannelBinding | undefined> {
  const [row] = await db
    .select()
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.botId, botId),
        eq(channelBindings.channelId, channelId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Shape a channel for any answer.
 * @param ch - The row.
 * @returns The serialized channel.
 */
export function serializePlatformChannel(ch: Channel) {
  return {
    id: ch.id,
    projectId: ch.projectId,
    type: ch.type,
    name: ch.name,
    botId: ch.botId,
    externalId: ch.externalId,
    parentExternalId: ch.parentExternalId,
    botInstallationId: ch.botInstallationId,
    isPrivate: ch.isPrivate,
    isShared: ch.isShared,
    archived: ch.archived,
    createdAt: ch.createdAt.getTime(),
    updatedAt: ch.updatedAt.getTime(),
  };
}

/**
 * Shape a binding for any answer.
 * @param b - The row.
 * @returns The serialized binding.
 */
export function serializeBinding(b: ChannelBinding) {
  return {
    id: b.id,
    projectId: b.projectId,
    botId: b.botId,
    channelId: b.channelId,
    mode: b.mode,
    defaultDelivery: b.defaultDelivery,
    approvalPolicy: b.approvalPolicy,
    approverExternalIds: b.approverExternalIds,
    allowPromotion: b.allowPromotion,
    allowShared: b.allowShared,
    enabled: b.enabled,
    autoBound: b.autoBound,
    createdByUserId: b.createdByUserId,
    createdAt: b.createdAt.getTime(),
    updatedAt: b.updatedAt.getTime(),
  };
}

/**
 * Shape a participant for any answer.
 * @param p - The row.
 * @returns The serialized participant.
 */
export function serializeParticipant(p: Participant) {
  return {
    id: p.id,
    projectId: p.projectId,
    type: p.type,
    externalWorkspaceId: p.externalWorkspaceId,
    externalUserId: p.externalUserId,
    displayName: p.displayName,
    isBot: p.isBot,
    firstSeenAt: p.firstSeenAt.getTime(),
    lastSeenAt: p.lastSeenAt.getTime(),
  };
}

/** The binding settings a person decides, shared by create and edit. */
export const bindingSettingsInputs = {
  mode: z
    .enum(BINDING_MODES)
    .describe(
      "mentions: only messages that address the bot (and replies in its threads); all: every message; dm: a direct message",
    ),
  defaultDelivery: z
    .enum(["steer", "queue"])
    .describe(
      "steer: a message reaches a working bot before its next step; queue: after its turn",
    ),
  approvalPolicy: z
    .enum(APPROVAL_POLICIES)
    .describe(
      "Who may decide the bot's tool-call approvals from inside the channel: dashboard (nobody; decide in the dashboard), participants (anyone in the channel), listed (only approverExternalIds)",
    ),
  approverExternalIds: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .describe("Platform user ids who may decide under the listed policy"),
  allowPromotion: z
    .boolean()
    .describe(
      "Whether facts from this channel may be promoted to project memory",
    ),
  allowShared: z
    .boolean()
    .describe(
      "Whether the bot answers in this channel even if it is shared with another organization",
    ),
  enabled: z.boolean().describe("Whether the bot listens here"),
};

/**
 * The 404 every unreadable or missing channel answers with.
 * @returns The error.
 */
export function channelNotFound(): TypedError {
  return new TypedError({
    message: "Channel not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * The 404 every unreadable or missing binding answers with.
 * @returns The error.
 */
export function bindingNotFound(): TypedError {
  return new TypedError({
    message: "Channel binding not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}
