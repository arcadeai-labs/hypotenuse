import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import type { Bot } from "../schema/bots";
import {
  MEMORY_SCOPES,
  type MemoryScopeName,
} from "../schema/memory_documents";
import type { Tag } from "../schema/tags";
import { assertCanWriteBot, loadReadableBot } from "./BotOps";
import type { DbHandle } from "./DbOps";
import { idInput } from "./InputOps";
import { isAdmin } from "./MembershipOps";
import {
  DEFAULT_HALF_LIFE_DAYS,
  type DocumentKey,
  keyIn,
  loadBotChannel,
  type MemoryReadSet,
  type ScopeChoice,
} from "./MemoryOps";

/**
 * Who may read and change memory from the dashboard, the API, the CLI, and
 * MCP. A bot's channel memory carries what that channel's members said, so it
 * follows the bot's own access lists; project memory is every member's to
 * read and an admin's to change.
 *
 * | Scope | Read | Write, forget, pin |
 * |---|---|---|
 * | `channel` | member + `canReadBot` | member + `canWriteBot` |
 * | `project` | member | admin |
 * | promote (channel → project) | — | `canWriteBot` **and** admin |
 *
 * A bot the caller cannot read, and a channel that is not the bot's, are the
 * same 404 as a document that does not exist.
 */

/** The input naming a scope. */
export const scopeNameInput = z
  .enum(MEMORY_SCOPES)
  .describe(
    "channel: one bot's memory of one channel (needs botId and channelId); project: memory every bot of the project shares",
  );

/** The input choosing scopes to search or list. */
export const scopeChoiceParam = z
  .enum(["channel", "project", "both"])
  .describe(
    "channel, project, or both; channel and both need botId and channelId",
  );

/** The optional bot and channel a channel-scoped call names. */
export const botChannelInputs = {
  botId: idInput(
    "The bot whose channel memory this is (required for channel scope)",
  ).optional(),
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

/** What a caller resolved to: the read set and the bot, if any. */
export interface ResolvedMemoryAccess {
  readSet: MemoryReadSet;
  bot: Bot | null;
}

/**
 * Resolve and check a caller's access to memory.
 * @param db - A database handle.
 * @param params - The project, the scope wanted, and the bot and channel.
 * @param callerTags - The caller's tags in the project.
 * @param intent - `read` or `write`.
 * @returns The read set to query within.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when channel scope
 *   lacks its bot or channel; `CONNECTION_ACTION_NOT_FOUND` for a bot or
 *   channel the caller cannot see; `CONNECTION_CHANNEL_AUTHORIZATION` for a
 *   write the caller may not make.
 */
export async function resolveMemoryAccess(
  db: DbHandle,
  params: {
    projectId: number;
    scope: ScopeChoice;
    botId?: number;
    channelId?: number;
  },
  callerTags: Tag[],
  intent: "read" | "write",
): Promise<ResolvedMemoryAccess> {
  const needsChannel = params.scope !== "project";
  if (needsChannel && (!params.botId || !params.channelId)) {
    throw new TypedError({
      message:
        "Channel memory belongs to one bot in one channel: pass both botId and channelId, or use scope project.",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: params.botId ? "channelId" : "botId",
    });
  }
  const bot = params.botId
    ? await loadReadableBot(db, params.projectId, params.botId, callerTags)
    : null;
  if (bot && needsChannel && params.channelId) {
    await loadBotChannel(db, params.projectId, bot.id, params.channelId);
  }
  if (intent === "write") {
    if (params.scope !== "project" && bot) assertCanWriteBot(bot, callerTags);
    if (params.scope !== "channel") assertMemoryAdmin(callerTags);
  }
  return {
    bot,
    readSet: {
      projectId: params.projectId,
      channel:
        needsChannel && bot && params.channelId
          ? { botId: bot.id, channelId: params.channelId }
          : null,
      halfLifeDays: bot
        ? {
            channel: bot.memoryChannelHalfLifeDays,
            project: bot.memoryProjectHalfLifeDays,
          }
        : { ...DEFAULT_HALF_LIFE_DAYS },
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
