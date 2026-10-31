import { and, count, eq, lt, sql } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { type Bot, bots } from "../schema/bots";
import type { Conversation } from "../schema/conversations";
import { type HelpRequest, helpRequests } from "../schema/help_requests";
import { canReadBot, canWriteBot } from "./BotOps";
import {
  enqueueTick,
  lockConversation,
  pingConversation,
  receiveMessage,
} from "./ConversationOps";
import type { DbHandle, TxHandle } from "./DbOps";
import { hasTag, isAdmin, resolveProjectAccess } from "./MembershipOps";
import { enqueueNotification, resolveRecipients } from "./NotificationOps";
import { enqueueDelivery } from "./OutboxOps";
import { emitStatus } from "./SurfaceOps";

/**
 * **Escalation to people.** When nobody in the channel can help, a bot calls
 * `escalate_to_human`: a `help_requests` row and its notifications are written
 * in one transaction, and the channel is told only "I've asked a person on
 * the team" — never the question, because it may be about the channel.
 *
 * | Event | Request | Conversation |
 * |---|---|---|
 * | raised, `blocking` | `pending` | `waiting` / `answer` |
 * | raised, not blocking | `pending` | the turn goes on |
 * | `help:answer` | `answered` | a `system` message "Answer from <name>: …" wakes it (or queues, mid-turn) |
 * | `help:cancel` | `cancelled` | a `system` message saying it was withdrawn |
 * | past `expiresAt` (`help:expire`) | `expired` | a `system` message saying nobody answered |
 *
 * A conversation raises at most `HELP_CAP_PER_CONVERSATION` (5) requests,
 * counted under its lock.
 */

/**
 * Who hears about a bot's request: holders of its `helpNotifyTag` who can
 * read the bot, else the project's admins (and its organization's owners).
 * @param bot - The bot.
 * @returns User ids.
 */
export async function resolveHelpRecipients(bot: Bot): Promise<number[]> {
  if (bot.helpNotifyTag) {
    const holders = await resolveRecipients(bot.projectId, bot.helpNotifyTag);
    const readers: number[] = [];
    for (const userId of holders) {
      const access = await resolveProjectAccess(userId, bot.projectId);
      if (access && canReadBot(bot, access.callerTags)) readers.push(userId);
    }
    if (readers.length > 0) return readers;
  }
  return resolveRecipients(bot.projectId, null);
}

/** What a bot asked for. */
export interface HelpDraft {
  question: string;
  context: string;
  urgency: "low" | "normal" | "high";
  blocking: boolean;
  timeoutSeconds: number;
}

/**
 * Raise a request: under the conversation's lock, check the cap, write the
 * row and its notifications, and tell the channel a person was asked.
 * @param conversationId - The conversation.
 * @param entryId - The `escalate_to_human` intent.
 * @param draft - What was asked.
 * @returns The request.
 * @throws {Error} With a sentence for the model when the cap is reached.
 */
export async function raiseHelpRequest(
  conversationId: number,
  entryId: number,
  draft: HelpDraft,
): Promise<HelpRequest> {
  let outboxWritten = false;
  const request = await api.db.db.transaction(async (tx) => {
    const locked = await lockConversation(tx, conversationId);
    if (!locked) throw new Error("The conversation is gone.");
    const { conversation, bot } = locked;
    const [existing] = await tx
      .select()
      .from(helpRequests)
      .where(eq(helpRequests.entryId, entryId))
      .limit(1);
    if (existing) return existing;
    const [{ n }] = await tx
      .select({ n: count() })
      .from(helpRequests)
      .where(eq(helpRequests.conversationId, conversationId));
    if (n >= config.platforms.helpCapPerConversation) {
      throw new HelpCapReached(config.platforms.helpCapPerConversation);
    }
    const [row] = await tx
      .insert(helpRequests)
      .values({
        projectId: conversation.projectId,
        botId: bot.id,
        conversationId,
        entryId,
        question: draft.question,
        context: draft.context,
        urgency: draft.urgency,
        blocking: draft.blocking,
        expiresAt: new Date(Date.now() + draft.timeoutSeconds * 1000),
      })
      .returning();
    await enqueueNotification(tx, {
      projectId: conversation.projectId,
      userIds: await resolveHelpRecipients(bot),
      template: "help-requested",
      payload: {
        helpRequestId: row.id,
        botName: bot.displayName,
        question: draft.question,
        urgency: draft.urgency,
        conversationId,
      },
      linkPath: `/help/${row.id}`,
    });
    const status = await emitStatus(
      tx,
      conversation,
      "I've asked a person on the team.",
    );
    outboxWritten = Boolean(status);
    return row;
  });
  if (outboxWritten) await enqueueDelivery([conversationId]);
  return request;
}

/** A conversation asked for help too many times. */
export class HelpCapReached extends Error {
  /** @param cap - The cap. */
  constructor(public cap: number) {
    super(`This conversation has already asked for help ${cap} times.`);
  }
}

/**
 * Settle a request and deliver what it means to its conversation as a
 * `system` message, under the conversation's lock.
 * @param tx - An open transaction.
 * @param request - The request (re-read under the lock).
 * @param settle - The new status, the answer, and who answered.
 * @param text - The message the conversation reads.
 * @returns The settled request, and the conversation if it woke.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when it is no longer pending.
 */
export async function settleHelpRequest(
  tx: TxHandle,
  request: HelpRequest,
  settle: {
    status: "answered" | "cancelled" | "expired";
    answer?: string;
    userId?: number | null;
  },
  text: string,
): Promise<{
  before: HelpRequest;
  request: HelpRequest;
  woke: Conversation | null;
}> {
  const locked = await lockConversation(tx, request.conversationId);
  const [before] = await tx
    .select()
    .from(helpRequests)
    .where(eq(helpRequests.id, request.id))
    .for("update");
  if (!before || !locked) throw helpNotFound();
  if (before.status !== "pending") {
    throw new TypedError({
      message: `This request was already ${before.status}.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "helpRequestId",
    });
  }
  const [row] = await tx
    .update(helpRequests)
    .set({
      status: settle.status,
      answer: settle.answer ?? null,
      answeredByUserId: settle.userId ?? null,
      answeredAt: new Date(),
    })
    .where(eq(helpRequests.id, request.id))
    .returning();
  const received = await receiveMessage(tx, locked.conversation, {
    text,
    delivery: "queue",
    deliveryKey: `help:${request.id}`,
    source: "system",
    metadata: { helpRequestId: request.id, status: settle.status },
  });
  return {
    before,
    request: row,
    woke: received.woke ? received.conversation : null,
  };
}

/**
 * Expire every pending request past its time. The clock's work; unaudited,
 * since nobody decided.
 * @param limit - The most to look at in one run.
 * @returns How many expired.
 */
export async function expireDueHelpRequests(limit = 200): Promise<number> {
  const due = await api.db.db
    .select()
    .from(helpRequests)
    .where(
      and(
        eq(helpRequests.status, "pending"),
        lt(helpRequests.expiresAt, sql`now()`),
      ),
    )
    .limit(limit);
  let expired = 0;
  for (const request of due) {
    try {
      const result = await api.db.db.transaction((tx) =>
        settleHelpRequest(
          tx,
          request,
          { status: "expired" },
          `Nobody on the team answered your request for help in time ("${request.question.slice(0, 200)}"). Carry on without it, and say so if it matters.`,
        ),
      );
      expired++;
      if (result.woke) await enqueueTick(result.woke);
      await pingConversation(request.projectId, request.conversationId);
    } catch (e) {
      if (!(e instanceof TypedError)) throw e;
    }
  }
  return expired;
}

/**
 * The 404 every unreadable or missing request answers with.
 * @returns The error.
 */
export function helpNotFound(): TypedError {
  return new TypedError({
    message: "Help request not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a request whose bot the caller may read.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param id - The request.
 * @param callerTags - The caller's tags.
 * @returns The request and its bot.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableHelpRequest(
  db: DbHandle,
  projectId: number,
  id: number,
  callerTags: Parameters<typeof canReadBot>[1],
): Promise<{ request: HelpRequest; bot: Bot }> {
  const [row] = await db
    .select({ request: helpRequests, bot: bots })
    .from(helpRequests)
    .innerJoin(bots, eq(bots.id, helpRequests.botId))
    .where(and(eq(helpRequests.id, id), eq(helpRequests.projectId, projectId)))
    .limit(1);
  if (!row || !canReadBot(row.bot, callerTags)) throw helpNotFound();
  return row;
}

/**
 * Shape a request for any answer.
 * @param r - The row.
 * @returns The serialized request.
 */
export function serializeHelpRequest(r: HelpRequest) {
  return {
    id: r.id,
    projectId: r.projectId,
    botId: r.botId,
    conversationId: r.conversationId,
    entryId: r.entryId,
    question: r.question,
    context: r.context,
    urgency: r.urgency,
    blocking: r.blocking,
    status: r.status,
    answer: r.answer,
    answeredByUserId: r.answeredByUserId,
    expiresAt: r.expiresAt.getTime(),
    createdAt: r.createdAt.getTime(),
    answeredAt: r.answeredAt?.getTime() ?? null,
  };
}

/**
 * Whether a person may answer a bot's requests for help: the people it
 * would notify (holders of its `helpNotifyTag`, or admins), and anyone who
 * may write the bot. Reading the bot is checked first, by the 404.
 * @param bot - The bot.
 * @param callerTags - The caller's tags.
 * @returns `true` if so.
 */
export function canAnswerHelp(
  bot: Bot,
  callerTags: Parameters<typeof canReadBot>[1],
): boolean {
  if (canWriteBot(bot, callerTags) || isAdmin(callerTags)) return true;
  return bot.helpNotifyTag ? hasTag(callerTags, bot.helpNotifyTag) : false;
}
