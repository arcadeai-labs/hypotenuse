import { and, asc, count, eq, inArray } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { type Bot, bots } from "../schema/bots";
import { channelBindings } from "../schema/channel_bindings";
import { type Channel, channels } from "../schema/channels";
import { conversations } from "../schema/conversations";
import {
  MEMORY_SCOPES,
  type MemoryScopeName,
  memoryDocuments,
} from "../schema/memory_documents";
import type { Tag } from "../schema/tags";
import { canReadBot, canWriteBot } from "./BotOps";
import type { DbHandle } from "./DbOps";
import { idInput } from "./InputOps";
import { isAdmin } from "./MembershipOps";
import {
  DEFAULT_HALF_LIFE_DAYS,
  type DocumentKey,
  keyIn,
  type MemoryReadSet,
  type ScopeChoice,
} from "./MemoryOps";

/**
 * Who may read and change memory from the dashboard, the API, the CLI, and
 * MCP. A channel's memory is shared by every bot working in it and carries
 * what that channel's members said, so it follows the access lists of those
 * bots: whoever may read (or change) any bot working in a channel may read
 * (or change) its memory. Project memory is every member's to read and an
 * admin's to change.
 *
 * | Scope | Read | Write, forget, pin |
 * |---|---|---|
 * | `channel`, a bot's own (API, dashboard chat) | member + `canReadBot` of that bot | member + `canWriteBot` of that bot |
 * | `channel`, a platform channel | member + `canReadBot` of any bot bound to it or with a conversation in it; admins always | the same with `canWriteBot` |
 * | `project` | member | admin |
 * | promote (channel → project) | — | channel write **and** admin |
 *
 * A channel the caller may not read is the same 404 as one that does not
 * exist, and as a document that does not exist.
 */

/** The input naming a scope. */
export const scopeNameInput = z
  .enum(MEMORY_SCOPES)
  .describe(
    "channel: the memory of one channel, shared by every bot working there (needs channelId); project: memory every bot of the project shares",
  );

/** The input choosing scopes to search or list. */
export const scopeChoiceParam = z
  .enum(["channel", "project", "both"])
  .describe("channel, project, or both; channel and both need channelId");

/** The optional channel a channel-scoped call names. */
export const channelInputs = {
  channelId: idInput(
    "The channel whose memory this is (required for channel scope)",
  ).optional(),
};

/** A query-string boolean: `true` / `false` as text or JSON. */
export const queryBoolean = (description: string) =>
  z
    .preprocess(
      (v) => (typeof v === "string" ? v === "true" || v === "1" : v),
      z.boolean(),
    )
    .optional()
    .describe(description);

/** What a caller may do with one channel's memory. */
export interface ChannelMemoryStanding {
  canRead: boolean;
  canWrite: boolean;
}

/** What a caller resolved to: the read set, and their standing on its channel. */
export interface ResolvedMemoryAccess {
  readSet: MemoryReadSet;
  channel: Channel | null;
  /** `null` for a project-only call. */
  standing: ChannelMemoryStanding | null;
}

/**
 * The bots working in each of a project's channels: a bot's own channel's
 * owner, and every bot bound to a platform channel or with a conversation in
 * it.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param channelIds - Only these channels; omit for all of them.
 * @returns Each channel's bots, by channel id.
 */
export async function botsByChannel(
  db: DbHandle,
  projectId: number,
  channelIds?: number[],
): Promise<Map<number, Bot[]>> {
  const byChannel = new Map<number, Bot[]>();
  if (channelIds && channelIds.length === 0) return byChannel;
  const projectBots = await db
    .select()
    .from(bots)
    .where(eq(bots.projectId, projectId))
    .orderBy(asc(bots.name), asc(bots.id));
  const botById = new Map(projectBots.map((b) => [b.id, b]));
  const pairs: { channelId: number; botId: number | null }[] = [
    ...(await db
      .select({ channelId: channels.id, botId: channels.botId })
      .from(channels)
      .where(
        and(
          eq(channels.projectId, projectId),
          channelIds ? inArray(channels.id, channelIds) : undefined,
        ),
      )),
    ...(await db
      .select({
        channelId: channelBindings.channelId,
        botId: channelBindings.botId,
      })
      .from(channelBindings)
      .where(
        and(
          eq(channelBindings.projectId, projectId),
          channelIds
            ? inArray(channelBindings.channelId, channelIds)
            : undefined,
        ),
      )),
    ...(await db
      .selectDistinct({
        channelId: conversations.channelId,
        botId: conversations.botId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.projectId, projectId),
          channelIds ? inArray(conversations.channelId, channelIds) : undefined,
        ),
      )),
  ];
  for (const { channelId, botId } of pairs) {
    const list = byChannel.get(channelId) ?? [];
    byChannel.set(channelId, list);
    const bot = botId === null ? undefined : botById.get(botId);
    if (bot && !list.includes(bot)) list.push(bot);
  }
  for (const list of byChannel.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }
  return byChannel;
}

/**
 * A caller's standing on one channel's memory (see the table above). An admin
 * passes every bot's access lists, so stands on every channel, worked in or
 * not.
 * @param working - The bots working in it.
 * @param callerTags - The caller's tags in the project.
 * @returns What they may do.
 */
export function channelMemoryStanding(
  working: Bot[],
  callerTags: Tag[],
): ChannelMemoryStanding {
  const admin = isAdmin(callerTags);
  return {
    canRead: admin || working.some((b) => canReadBot(b, callerTags)),
    canWrite: admin || working.some((b) => canWriteBot(b, callerTags)),
  };
}

/**
 * Load a channel of the project whose memory the caller may read.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param channelId - The channel.
 * @param callerTags - The caller's tags in the project.
 * @returns The channel, the bots working in it, and the caller's standing.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableMemoryChannel(
  db: DbHandle,
  projectId: number,
  channelId: number,
  callerTags: Tag[],
): Promise<{
  channel: Channel;
  bots: Bot[];
  standing: ChannelMemoryStanding;
}> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.projectId, projectId)))
    .limit(1);
  const working = channel
    ? ((await botsByChannel(db, projectId, [channel.id])).get(channel.id) ?? [])
    : [];
  const standing = channel ? channelMemoryStanding(working, callerTags) : null;
  if (!channel || !standing?.canRead) {
    throw new TypedError({
      message: "Channel not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return { channel, bots: working, standing };
}

/**
 * The channels of a project whose memory the caller may read, each with how
 * many live documents it holds, the bots working in it, and the caller's
 * standing — the memory explorer's index. Channels without a document come
 * too, so a person can start one.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param callerTags - The caller's tags in the project.
 * @returns The channels, by name.
 */
export async function readableMemoryChannels(
  db: DbHandle,
  projectId: number,
  callerTags: Tag[],
): Promise<
  {
    channel: Channel;
    documents: number;
    bots: Bot[];
    standing: ChannelMemoryStanding;
  }[]
> {
  const rows = await db
    .select({ channel: channels, documents: count(memoryDocuments.id) })
    .from(channels)
    .leftJoin(
      memoryDocuments,
      and(
        eq(memoryDocuments.channelId, channels.id),
        eq(memoryDocuments.scope, "channel"),
        eq(memoryDocuments.isCurrent, true),
        eq(memoryDocuments.tombstone, false),
      ),
    )
    .where(eq(channels.projectId, projectId))
    .groupBy(channels.id)
    .orderBy(asc(channels.name), asc(channels.id));
  const working = await botsByChannel(db, projectId);
  const out = [];
  for (const row of rows) {
    const list = working.get(row.channel.id) ?? [];
    const standing = channelMemoryStanding(list, callerTags);
    if (standing.canRead) out.push({ ...row, bots: list, standing });
  }
  return out;
}

/**
 * Resolve and check a caller's access to memory.
 * @param db - A database handle.
 * @param params - The project, the scope wanted, and the channel.
 * @param callerTags - The caller's tags in the project.
 * @param intent - `read` or `write`.
 * @returns The read set to query within.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when channel scope
 *   lacks its channel; `CONNECTION_ACTION_NOT_FOUND` for a channel the caller
 *   cannot see; `CONNECTION_CHANNEL_AUTHORIZATION` for a write the caller may
 *   not make.
 */
export async function resolveMemoryAccess(
  db: DbHandle,
  params: {
    projectId: number;
    scope: ScopeChoice;
    channelId?: number;
  },
  callerTags: Tag[],
  intent: "read" | "write",
): Promise<ResolvedMemoryAccess> {
  const needsChannel = params.scope !== "project";
  if (needsChannel && !params.channelId) {
    throw new TypedError({
      message:
        "Channel memory belongs to one channel: pass channelId, or use scope project.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "channelId",
    });
  }
  const loaded =
    needsChannel && params.channelId
      ? await loadReadableMemoryChannel(
          db,
          params.projectId,
          params.channelId,
          callerTags,
        )
      : null;
  if (intent === "write") {
    if (loaded && !loaded.standing.canWrite) {
      throw new TypedError({
        message:
          "You can read this channel's memory but not change it: that takes write access to a bot working in the channel. Ask someone who may change one of them, or an admin.",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    if (params.scope !== "channel") assertMemoryAdmin(callerTags);
  }
  return {
    channel: loaded?.channel ?? null,
    standing: loaded?.standing ?? null,
    readSet: {
      projectId: params.projectId,
      channel: loaded ? { channelId: loaded.channel.id } : null,
      halfLifeDays: { ...DEFAULT_HALF_LIFE_DAYS },
    },
  };
}

/**
 * Refuse a caller without admin standing a change to project memory.
 * @param callerTags - The caller's tags.
 * @throws {TypedError} `CONNECTION_CHANNEL_AUTHORIZATION`.
 */
export function assertMemoryAdmin(callerTags: Tag[]): void {
  if (isAdmin(callerTags)) return;
  throw new TypedError({
    message:
      "Project memory is shared by every bot and channel of the project, so only a project admin changes it.",
    type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
  });
}

/**
 * The key of one document a resolved caller names.
 * @param access - The resolved access.
 * @param scope - Its scope.
 * @param path - Its path.
 * @returns The key.
 */
export function documentKey(
  access: ResolvedMemoryAccess,
  scope: MemoryScopeName,
  path: string,
): DocumentKey {
  return keyIn(access.readSet, scope, path);
}
