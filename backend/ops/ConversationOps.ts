import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { approvals } from "../schema/approvals";
import type { Bot } from "../schema/bots";
import { bots } from "../schema/bots";
import { type Channel, channels } from "../schema/channels";
import { conversationEntries } from "../schema/conversation_entries";
import {
  type ConversationInboxRow,
  conversationInbox,
  type InboxDelivery,
  type InboxSource,
} from "../schema/conversation_inbox";
import {
  type Conversation,
  type ConversationState,
  conversations,
} from "../schema/conversations";
import { outboxMessages } from "../schema/outbox_messages";
import type { Tag } from "../schema/tags";
import { canReadBot } from "./BotOps";
import { abandonCodeRuns } from "./CodeRunOps";
import type { DbHandle } from "./DbOps";
import { appendEntries, type EntryDraft } from "./TranscriptOps";

/**
 * Conversations: the state machine, the one wake operation, inbound messages,
 * and cancellation. Every move into `working` goes through {@link wake}, so
 * its lock order (bot, then conversation) cannot drift between callers.
 *
 * | State ↓ / Event → | Inbound message | Cancel |
 * |---|---|---|
 * | `working` | inbox row; a `steer` row enters at the next step, a `queue` row at the turn's end | a live lease: flag it and wake, the tick finalizes; no live lease: finalize here |
 * | `hibernating` | wake: new turn | finalize |
 * | `waiting` (answer) | the message is the answer: wake, same turn | finalize |
 * | `waiting` (timer, approval, sandbox) | inbox row kept until the wait ends | finalize; its pending approvals expire |
 * | `ended` | wake: new turn, outcome cleared | no-op |
 */

/** The WebSocket channel name for one conversation. */
export function conversationChannel(
  projectId: number,
  conversationId: number,
): string {
  return `project:${projectId}:conversation:${conversationId}`;
}

/** The channel-name shape {@link conversationChannel} produces. */
export const CONVERSATION_CHANNEL_PATTERN =
  /^project:(\d+):conversation:(\d+)$/;

/** The one frame ever published on a conversation channel. */
export const CONVERSATION_FRAME = { event: "conversation" } as const;

/**
 * Publish a content-free ping saying a conversation changed. Never throws: a
 * frame is an accelerant, and the page re-reads entries over HTTP.
 * @param projectId - The project.
 * @param conversationId - The conversation.
 */
export async function pingConversation(
  projectId: number,
  conversationId: number,
): Promise<void> {
  try {
    await api.pubsub.broadcast(
      conversationChannel(projectId, conversationId),
      JSON.stringify(CONVERSATION_FRAME),
      "agent:tick",
    );
  } catch (e) {
    api.logger.warn("could not ping a conversation channel", {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Shape a conversation for any answer. Timestamps are epoch ms.
 * @param c - The row.
 * @returns The serialized conversation.
 */
export function serializeConversation(c: Conversation) {
  return {
    id: c.id,
    projectId: c.projectId,
    botId: c.botId,
    channelId: c.channelId,
    title: c.title,
    state: c.state,
    waitingOn: c.waitingOn,
    outcome: c.outcome,
    epoch: c.epoch,
    working: c.state === "working",
    cancelRequested: c.cancelRequestedAt !== null,
    lastSeq: c.lastSeq,
    hasCallback: c.callbackUrl !== null,
    externalConversationKey: c.externalConversationKey,
    requestId: c.requestId,
    createdByUserId: c.createdByUserId,
    lastActivityAt: c.lastActivityAt.getTime(),
    createdAt: c.createdAt.getTime(),
    updatedAt: c.updatedAt.getTime(),
  };
}

/**
 * Shape a channel for any answer.
 * @param ch - The row.
 * @returns The serialized channel.
 */
export function serializeChannel(ch: Channel) {
  return {
    id: ch.id,
    projectId: ch.projectId,
    type: ch.type,
    name: ch.name,
    botId: ch.botId,
    externalId: ch.externalId,
    isPrivate: ch.isPrivate,
    createdAt: ch.createdAt.getTime(),
  };
}

/**
 * Find or create a bot's API channel for a key.
 * @param tx - An open transaction.
 * @param bot - The bot.
 * @param key - The caller's channel key.
 * @returns The channel.
 */
export async function upsertApiChannel(
  tx: DbHandle,
  bot: Bot,
  key: string,
): Promise<Channel> {
  const externalId = `bot:${bot.id}:${key}`;
  await tx
    .insert(channels)
    .values({
      projectId: bot.projectId,
      type: "api",
      externalId,
      botId: bot.id,
      name: key,
    })
    .onConflictDoNothing();
  const [channel] = await tx
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.projectId, bot.projectId),
        eq(channels.type, "api"),
        eq(channels.externalId, externalId),
      ),
    )
    .limit(1);
  return channel;
}

/**
 * The 404 every unreadable or missing conversation answers with.
 * @returns The error.
 */
export function conversationNotFound(): TypedError {
  return new TypedError({
    message: "Conversation not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a conversation whose bot the caller may read. A missing conversation,
 * one in another project, and one whose bot the caller cannot read are the
 * **same** 404.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param conversationId - The conversation.
 * @param callerTags - The caller's tags in the project.
 * @returns The conversation and its bot.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableConversation(
  db: DbHandle,
  projectId: number,
  conversationId: number,
  callerTags: Tag[],
): Promise<{ conversation: Conversation; bot: Bot }> {
  const [row] = await db
    .select({ conversation: conversations, bot: bots })
    .from(conversations)
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row || !canReadBot(row.bot, callerTags)) throw conversationNotFound();
  return row;
}

/**
 * Lock a conversation for a state change, bot first (`FOR SHARE`), then the
 * conversation (`FOR UPDATE`): the one lock order every writer uses.
 * @param tx - An open transaction.
 * @param conversationId - The conversation.
 * @returns The locked conversation and its bot, or `null` if it is gone.
 */
export async function lockConversation(
  tx: DbHandle,
  conversationId: number,
): Promise<{ conversation: Conversation; bot: Bot } | null> {
  const [ref] = await tx
    .select({ botId: conversations.botId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!ref) return null;
  const [bot] = await tx
    .select()
    .from(bots)
    .where(eq(bots.id, ref.botId))
    .for("share");
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  if (!bot || !conversation) return null;
  return { conversation, bot };
}

/** Why a conversation was woken, for its `status_change` entry. */
export type WakeReason =
  | "message"
  | "answer"
  | "timer"
  | "question_timeout"
  | "approval"
  | "cancel"
  | "created";

/**
 * **The wake operation**: the only code that moves a conversation into
 * `working`. It must run inside the caller's transaction with the
 * conversation already locked by {@link lockConversation}; after that
 * transaction commits, the caller calls {@link enqueueTick}.
 *
 * | From | Then |
 * |---|---|
 * | new (`hibernating` at epoch 0), `hibernating`, `ended` | a new turn: epoch + 1, step count and nudge reset, outcome cleared |
 * | `waiting` | the same turn resumes: `waitingOn` cleared, every pending inbox row delivered at the next step |
 * | `working` | nothing changes but the owed-tick flag |
 * @param tx - An open transaction.
 * @param conversation - The conversation, locked.
 * @param reason - Why, recorded on the `status_change` entry.
 * @returns The updated conversation.
 */
export async function wake(
  tx: DbHandle,
  conversation: Conversation,
  reason: WakeReason,
): Promise<Conversation> {
  const now = new Date();
  if (conversation.state === "working") {
    const [row] = await tx
      .update(conversations)
      .set({ wakeRequestedAt: conversation.wakeRequestedAt ?? now })
      .where(eq(conversations.id, conversation.id))
      .returning();
    return row;
  }
  const resuming = conversation.state === "waiting";
  const from =
    conversation.epoch === 0 && conversation.lastSeq === 0
      ? "new"
      : conversation.state;
  const epoch = resuming ? conversation.epoch : conversation.epoch + 1;
  await appendEntries(tx, conversation.id, epoch, [
    statusChange(from, "working", reason),
  ]);
  const [row] = await tx
    .update(conversations)
    .set({
      state: "working",
      waitingOn: null,
      wakeRequestedAt: now,
      turnBoundary: true,
      ...(resuming
        ? {}
        : {
            epoch,
            outcome: null,
            stepsThisTurn: 0,
            nudgedThisTurn: false,
          }),
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return row;
}

/**
 * A `status_change` entry draft.
 * @param from - The state left.
 * @param to - The state entered.
 * @param reason - Why.
 * @param extra - A sentence for people, and whether the model must see it.
 * @returns The draft.
 */
export function statusChange(
  from: ConversationState | "new",
  to: ConversationState,
  reason: string,
  extra: { text?: string; visibleToModel?: boolean; outcome?: string } = {},
): EntryDraft {
  return {
    kind: "status_change",
    content: {
      from,
      to,
      reason,
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      text: extra.text ?? null,
      visibleToModel: extra.visibleToModel ?? false,
    },
  };
}

/**
 * Enqueue the tick a wake owes. An accelerant only: if it is lost,
 * `agents:wake-due` finds the conversation from `wakeRequestedAt`.
 * @param conversation - The woken conversation.
 * @param delayMs - Wait this long first.
 */
export async function enqueueTick(
  conversation: Pick<Conversation, "id" | "wakeRequestedAt">,
  delayMs = 0,
): Promise<void> {
  const params = {
    conversationId: conversation.id,
    wake: conversation.wakeRequestedAt?.getTime() ?? Date.now(),
  };
  if (delayMs > 0) {
    await api.actions.enqueueIn(delayMs, "agent:tick", params, "agents", true);
  } else {
    await api.actions.enqueue("agent:tick", params, "agents");
  }
}

/** What a person's message did to the conversation. */
export interface InboundResult {
  conversation: Conversation;
  inbox: ConversationInboxRow;
  /** The same `deliveryKey` was seen before; nothing changed. */
  duplicate: boolean;
  /** A tick is owed and must be enqueued after commit. */
  woke: boolean;
}

/**
 * Take in a message: insert its inbox row (a repeated `deliveryKey` changes
 * nothing) and apply the state table's "inbound message" column. Runs in the
 * caller's transaction with the conversation locked.
 * @param tx - An open transaction.
 * @param conversation - The conversation, locked.
 * @param message - The text, how it enters a turn, its dedupe key, and who wrote it.
 * @returns What happened.
 */
export async function receiveMessage(
  tx: DbHandle,
  conversation: Conversation,
  message: {
    text: string;
    delivery: InboxDelivery;
    deliveryKey?: string;
    source: InboxSource;
    userId?: number | null;
    participantId?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<InboundResult> {
  const deliveryKey = message.deliveryKey ?? randomUUID();
  const [inserted] = await tx
    .insert(conversationInbox)
    .values({
      conversationId: conversation.id,
      deliveryKey,
      delivery: message.delivery,
      source: message.source,
      userId: message.userId ?? null,
      participantId: message.participantId ?? null,
      text: message.text,
      metadata: message.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(conversationInbox)
      .where(
        and(
          eq(conversationInbox.conversationId, conversation.id),
          eq(conversationInbox.deliveryKey, deliveryKey),
        ),
      )
      .limit(1);
    return { conversation, inbox: existing, duplicate: true, woke: false };
  }

  const waitingOn = conversation.waitingOn;
  const wakes =
    conversation.state === "hibernating" ||
    conversation.state === "ended" ||
    (conversation.state === "waiting" && waitingOn?.kind === "answer");
  if (!wakes) {
    await tx
      .update(conversations)
      .set({ lastActivityAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { conversation, inbox: inserted, duplicate: false, woke: false };
  }
  const woken = await wake(
    tx,
    conversation,
    conversation.state === "waiting" ? "answer" : "message",
  );
  return { conversation: woken, inbox: inserted, duplicate: false, woke: true };
}

/** Outbox kinds that are progress, not a final message: a cancel supersedes them. */
export const NON_FINAL_OUTBOX_KINDS = ["status", "stream", "plan"];

/** What a cancel request did. */
export type CancelResult =
  | { kind: "noop"; conversation: Conversation }
  | { kind: "ended"; conversation: Conversation }
  | { kind: "requested"; conversation: Conversation };

/**
 * Cancel a conversation. With no tick holding it, it ends here; with a live
 * lease, the flag is set and the holder (which checks it before every step and
 * tool, and aborts the model call) finalizes it. Runs in the caller's
 * transaction with the conversation locked.
 * @param tx - An open transaction.
 * @param conversation - The conversation, locked.
 * @returns What happened; `requested` owes a tick after commit.
 */
export async function requestCancel(
  tx: DbHandle,
  conversation: Conversation,
): Promise<CancelResult> {
  if (conversation.state === "ended") return { kind: "noop", conversation };
  const leaseLive =
    conversation.leaseExpiresAt !== null &&
    conversation.leaseExpiresAt.getTime() > Date.now();
  if (conversation.state === "working" && leaseLive) {
    const [flagged] = await tx
      .update(conversations)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(conversations.id, conversation.id))
      .returning();
    const woken = await wake(tx, flagged, "cancel");
    return { kind: "requested", conversation: woken };
  }
  const ended = await finalizeCancel(tx, conversation);
  return { kind: "ended", conversation: ended };
}

/**
 * End a conversation as cancelled: settle every open intent as interrupted,
 * end any wait (expiring its pending approvals), release any lease, and
 * supersede outbox rows that were only
 * progress. Runs with the conversation locked.
 * @param tx - An open transaction.
 * @param conversation - The conversation, locked.
 * @returns The ended conversation.
 */
export async function finalizeCancel(
  tx: DbHandle,
  conversation: Conversation,
): Promise<Conversation> {
  const open = await openIntents(tx, conversation.id);
  await appendEntries(tx, conversation.id, conversation.epoch, [
    ...open.map((intent) =>
      interruptedResult(
        intent,
        "The conversation was cancelled before this call finished. It may or may not have run.",
      ),
    ),
    statusChange(conversation.state, "ended", "cancelled", {
      outcome: "cancelled",
      text: "The conversation was cancelled.",
    }),
  ]);
  // A paused program can no longer resume.
  await abandonCodeRuns(tx, conversation.id);
  // An approval nobody decided can no longer run anything.
  await tx
    .update(approvals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(
      and(
        eq(approvals.conversationId, conversation.id),
        eq(approvals.status, "pending"),
      ),
    );
  await tx
    .update(outboxMessages)
    .set({ status: "superseded" })
    .where(
      and(
        eq(outboxMessages.conversationId, conversation.id),
        inArray(outboxMessages.status, ["pending", "failed"]),
        inArray(outboxMessages.kind, NON_FINAL_OUTBOX_KINDS),
      ),
    );
  const [row] = await tx
    .update(conversations)
    .set({
      state: "ended",
      outcome: "cancelled",
      waitingOn: null,
      cancelRequestedAt: null,
      wakeRequestedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      turnBoundary: true,
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return row;
}

/**
 * Every `tool_call_intent` with no `tool_result`: calls that were cut off.
 * A result is matched to its intent by step and call id.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @returns The open intents, oldest first.
 */
export async function openIntents(db: DbHandle, conversationId: number) {
  return db
    .select()
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        eq(conversationEntries.kind, "tool_call_intent"),
        sql`not exists (
          select 1 from conversation_entries r
          where r.conversation_id = ${conversationEntries.conversationId}
            and r.kind = 'tool_result'
            and r.step_id is not distinct from ${conversationEntries.stepId}
            and r.tool_call_id = ${conversationEntries.toolCallId}
        )`,
      ),
    )
    .orderBy(conversationEntries.seq);
}

/**
 * The `tool_result` that settles an intent as interrupted (pi's rule): the
 * model is told, and decides.
 * @param intent - The open intent.
 * @param message - What happened.
 * @returns The draft.
 */
export function interruptedResult(
  intent: {
    stepId: string | null;
    toolCallId: string | null;
    toolName: string | null;
  },
  message = "This call may or may not have run before the worker stopped. Check before repeating it.",
): EntryDraft {
  return {
    kind: "tool_result",
    role: "tool",
    stepId: intent.stepId,
    toolCallId: intent.toolCallId,
    toolName: intent.toolName,
    content: {
      output: {
        is_error: true,
        error_type: "interrupted",
        message,
        next_action_hint:
          "Look at what you can see of its effects before calling it again; if you cannot tell, say so to the person.",
      },
    },
  };
}

/** The Zod input for a message's text. */
export const messageTextInput = z
  .string()
  .trim()
  .min(1, "A message needs text")
  .max(40_000, "A message is at most 40,000 characters")
  .describe("The message, in markdown");

/** The Zod input for a client's dedupe key. */
export const requestIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Your own id for this request. Sending the same one again returns the first result instead of acting twice, so a retry is safe",
  );

/** The Zod input for how a message enters a running turn. */
export const deliveryInput = z
  .enum(["steer", "queue"])
  .describe(
    "steer (the default): the bot sees it before its next step, even mid-turn; queue: it waits until the bot's current turn ends",
  );

/**
 * The record of a message's text an audit row keeps: its length and digest,
 * never the words.
 * @param text - The text.
 * @returns The summary.
 */
export function summarizeText(text: string) {
  return {
    length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
