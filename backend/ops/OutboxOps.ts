import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/agents";
import type {} from "../config/platforms";
import { surfaceAdapter } from "../platforms/registry";
import type { SendResult, SurfaceContext } from "../platforms/types";
import { botInstallations } from "../schema/bot_installations";
import { channels } from "../schema/channels";
import { conversations } from "../schema/conversations";
import { type OutboxMessage, outboxMessages } from "../schema/outbox_messages";
import { acquireLease, releaseLease } from "./LockOps";

export {
  CALLBACK_SECRET_PREFIX,
  generateCallbackSecret,
  signCallback,
  verifyCallbackSignature,
} from "./SignatureOps";

/**
 * **The outbox**: everything a bot writes to the world, recorded in the
 * transaction that decided it (`SurfaceOps.emit`) and delivered after commit
 * through the conversation's surface adapter. The row id is the delivery id
 * a receiver dedupes on, so a retry after a lost response is harmless.
 *
 * Delivery is per conversation, in `id` order, by one deliverer at a time:
 *
 * 1. `outbox:deliver` (enqueued after the commit that wrote rows) takes the
 *    Redis lease `outbox:deliver:<conversationId>`, released only by its holder.
 * 2. It sends the conversation's due rows oldest first, skipping superseded
 *    ones. A row that must wait (backed off, or claimed by a deliverer that
 *    died) stops the walk, so nothing overtakes it.
 * 3. It records `externalMessageId` with `sent`, in one write.
 * 4. It releases the lease. `outbox:deliver-due` fans out over conversations
 *    with due rows, a few at a time, for whatever an accelerant missed.
 *
 * | Send result | Then |
 * |---|---|
 * | `sent` | `sent`, with the platform's message id |
 * | `retry` | `failed`, retried after back-off (or the platform's `Retry-After`) until the window (24 h) ends, then `undeliverable` |
 * | `undeliverable` | `undeliverable`, with the reason |
 */

/**
 * Enqueue delivery for conversations whose rows just committed. An
 * accelerant: `outbox:deliver-due` finds anything this loses.
 * @param conversationIds - The conversations.
 */
export async function enqueueDelivery(
  conversationIds: number[],
): Promise<void> {
  for (const conversationId of new Set(conversationIds)) {
    try {
      await api.actions.enqueue("outbox:deliver", { conversationId }, "outbox");
    } catch (e) {
      api.logger.warn("could not enqueue an outbox delivery", {
        conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/** The condition of a row a deliverer may attempt now. */
function dueCondition() {
  return and(
    inArray(outboxMessages.status, ["pending", "failed", "sending"]),
    lte(outboxMessages.nextAttemptAt, new Date()),
  );
}

/**
 * Conversations with a row due: never tried, backed off long enough, or
 * stuck past its claim.
 * @param limit - The most to return.
 * @returns Their ids, the longest-waiting first.
 */
export async function dueConversationIds(limit: number): Promise<number[]> {
  const rows = await api.db.db
    .select({
      conversationId: outboxMessages.conversationId,
      due: sql<Date>`min(${outboxMessages.nextAttemptAt})`,
    })
    .from(outboxMessages)
    .where(dueCondition())
    .groupBy(outboxMessages.conversationId)
    .orderBy(sql`min(${outboxMessages.nextAttemptAt})`)
    .limit(limit);
  return rows.map((r) => r.conversationId);
}

/** What one delivery attempt did. */
export type DeliveryOutcome = "sent" | "retry" | "undeliverable" | "skipped";

/**
 * The context a row is sent with.
 * @param conversationId - The conversation.
 * @param installationId - The row's installation, if any.
 * @returns The context, or `null` if the conversation is gone.
 */
async function sendContext(
  conversationId: number,
  installationId: number | null,
): Promise<SurfaceContext | null> {
  const [row] = await api.db.db
    .select({ conversation: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return null;
  const [installation] = installationId
    ? await api.db.db
        .select()
        .from(botInstallations)
        .where(eq(botInstallations.id, installationId))
        .limit(1)
    : [];
  return { ...row, installation: installation ?? null };
}

/**
 * Claim one row into `sending`. The claim pushes `nextAttemptAt` past the
 * request's timeout, which is how a row whose deliverer died becomes due
 * again.
 * @param id - The row.
 * @returns The claimed row, or `null` if it is not due or someone else has it.
 */
async function claimRow(id: number): Promise<OutboxMessage | null> {
  const timeout = config.agents.callbackTimeoutMs;
  const [row] = await api.db.db
    .update(outboxMessages)
    .set({
      status: "sending",
      attempts: sql`${outboxMessages.attempts} + 1`,
      nextAttemptAt: new Date(Date.now() + timeout * 3),
    })
    .where(
      and(
        eq(outboxMessages.id, id),
        or(
          inArray(outboxMessages.status, ["pending", "failed"]),
          eq(outboxMessages.status, "sending"),
        ),
        lte(outboxMessages.nextAttemptAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Send a claimed row through its adapter and record the outcome. **Never
 * throws.**
 * @param row - The claimed row.
 * @param ctx - Where it goes.
 * @returns The outcome recorded.
 */
async function sendRow(
  row: OutboxMessage,
  ctx: SurfaceContext | null,
): Promise<DeliveryOutcome> {
  if (!ctx) {
    return settle(row, {
      outcome: "undeliverable",
      error: "The conversation is gone.",
    });
  }
  const adapter = surfaceAdapter(ctx.channel.type);
  if (!adapter) {
    return settle(row, {
      outcome: "undeliverable",
      error: `There is no "${ctx.channel.type}" surface.`,
    });
  }
  let result: SendResult;
  try {
    result = await adapter.send(row, ctx);
  } catch (e) {
    result = {
      outcome: "retry",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return settle(row, result);
}

/**
 * Attempt one row on its own, outside the per-conversation walk. **Never
 * throws.**
 * @param id - The outbox row.
 * @returns What happened.
 */
export async function deliverOutboxMessage(
  id: number,
): Promise<DeliveryOutcome> {
  const row = await claimRow(id);
  if (!row) return "skipped";
  return sendRow(
    row,
    await sendContext(row.conversationId, row.botInstallationId),
  );
}

/** What one walk of a conversation's outbox did. */
export interface ConversationDelivery {
  /** Another deliverer held the conversation's lease. */
  leased: boolean;
  outcomes: DeliveryOutcome[];
}

/**
 * **Deliver a conversation's due rows, in order**, under its lease. A row that
 * must wait stops the walk, so a later row never overtakes an earlier one.
 * @param conversationId - The conversation.
 * @returns What was attempted.
 */
export async function deliverConversation(
  conversationId: number,
): Promise<ConversationDelivery> {
  const lease = await acquireLease(
    `outbox:deliver:${conversationId}`,
    config.platforms.deliverLeaseMs,
  );
  if (!lease) return { leased: true, outcomes: [] };
  const outcomes: DeliveryOutcome[] = [];
  try {
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversationId),
          inArray(outboxMessages.status, ["pending", "failed", "sending"]),
        ),
      )
      .orderBy(asc(outboxMessages.id));
    let ctx: SurfaceContext | null | undefined;
    for (const pending of rows) {
      const row = await claimRow(pending.id);
      // Superseded meanwhile, or not due: in either case it is not ours to
      // overtake. A superseded row no longer blocks.
      if (!row) {
        const [now] = await api.db.db
          .select({ status: outboxMessages.status })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, pending.id));
        if (now?.status === "superseded" || now?.status === "sent") continue;
        break;
      }
      ctx ??= await sendContext(conversationId, row.botInstallationId);
      const outcome = await sendRow(row, ctx);
      outcomes.push(outcome);
      if (outcome === "retry") break;
    }
  } finally {
    await releaseLease(lease).catch(() => false);
  }
  return { leased: false, outcomes };
}

/**
 * Record an attempt's outcome. A retry past the window is undeliverable.
 * @param row - The row as claimed.
 * @param result - What the adapter said.
 * @returns The outcome recorded.
 */
async function settle(
  row: OutboxMessage,
  result: SendResult,
): Promise<DeliveryOutcome> {
  const now = Date.now();
  let final: DeliveryOutcome = result.outcome;
  if (
    final === "retry" &&
    now - row.createdAt.getTime() > config.agents.outboxRetryWindowMs
  ) {
    final = "undeliverable";
  }
  const backoff = Math.max(
    Math.min(
      config.agents.outboxRetryBaseMs * 2 ** Math.max(0, row.attempts - 1),
      60 * 60 * 1000,
    ),
    result.retryAfterMs ?? 0,
  );
  const error = result.error ?? null;
  try {
    await api.db.db
      .update(outboxMessages)
      .set(
        final === "sent"
          ? {
              status: "sent",
              sentAt: new Date(),
              error: null,
              externalMessageId: result.externalMessageId ?? null,
            }
          : final === "retry"
            ? {
                status: "failed",
                error,
                nextAttemptAt: new Date(now + backoff),
              }
            : { status: "undeliverable", error },
      )
      .where(
        and(
          eq(outboxMessages.id, row.id),
          eq(outboxMessages.status, "sending"),
        ),
      );
  } catch (e) {
    api.logger.error("could not record an outbox attempt", {
      outboxMessageId: row.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return final;
}
