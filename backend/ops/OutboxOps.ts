import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/agents";
import { bots } from "../schema/bots";
import type { Conversation } from "../schema/conversations";
import { conversations } from "../schema/conversations";
import { type OutboxMessage, outboxMessages } from "../schema/outbox_messages";
import type { Outbound } from "../tools/types";
import { decryptSecret } from "./CryptoOps";
import type { DbHandle } from "./DbOps";
import { guardedFetch, HostRefused } from "./NetworkGuardOps";

/**
 * The outbox: everything a bot writes to the world, recorded in the step's
 * transaction and delivered after commit. Here it serves only the API
 * channel's signed callback.
 *
 * A callback is `POST`ed as JSON `{conversationId, entrySeq, kind, text,
 * options?}` with two headers:
 *
 * - `Hypotenuse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 * - `Hypotenuse-Delivery: <outbox row id>`, the same on every retry, so a
 *   receiver drops a duplicate.
 *
 * | Answer | Then |
 * |---|---|
 * | 2xx | `sent` |
 * | 408, 429, 5xx, a network error, a lost response | `failed`, retried with back-off until the window (24 h) ends, then `undeliverable` |
 * | any other 4xx, a refused host, no secret | `undeliverable` |
 */

/** The prefix every callback secret carries, so one is recognizable in a leak. */
export const CALLBACK_SECRET_PREFIX = "hyp_cbs_";

/**
 * A fresh callback secret.
 * @returns The plaintext secret.
 */
export function generateCallbackSecret(): string {
  return `${CALLBACK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Sign a callback body.
 * @param secret - The bot's callback secret.
 * @param body - The exact body bytes, as text.
 * @param timestamp - Unix seconds.
 * @returns The `Hypotenuse-Signature` header value.
 */
export function signCallback(
  secret: string,
  body: string,
  timestamp: number,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify a callback signature the way a receiver should: recompute the HMAC
 * over the raw body, compare in constant time, and refuse an old timestamp.
 * @param secret - The bot's callback secret.
 * @param header - The `Hypotenuse-Signature` header.
 * @param body - The raw body, as text.
 * @param toleranceSeconds - How old a signature may be.
 * @returns Whether it is genuine and fresh.
 */
export function verifyCallbackSignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signCallback(secret, body, t).split("v1=")[1]);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Record an outbound message for delivery, in the step's transaction. Only a
 * conversation with a callback URL has anywhere to deliver to; without one,
 * the transcript entry is the message and a poller reads it.
 * @param tx - An open transaction.
 * @param conversation - The conversation.
 * @param seq - The transcript entry the message came from.
 * @param outbound - What to send.
 * @returns The row, or `null` when there is no callback.
 */
export async function queueOutbound(
  tx: DbHandle,
  conversation: Conversation,
  seq: number,
  outbound: Outbound,
): Promise<OutboxMessage | null> {
  if (!conversation.callbackUrl) return null;
  const [row] = await tx
    .insert(outboxMessages)
    .values({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      seq,
      kind: outbound.kind,
      payload: {
        conversationId: conversation.id,
        entrySeq: seq,
        kind: outbound.kind,
        text: outbound.text,
        ...(outbound.options ? { options: outbound.options } : {}),
      },
      target: { type: "api-callback", url: conversation.callbackUrl },
    })
    .returning();
  return row;
}

/**
 * Enqueue delivery of outbox rows after their transaction committed. An
 * accelerant: `outbox:deliver-due` finds anything this loses.
 * @param ids - The rows.
 */
export async function enqueueDeliveries(ids: number[]): Promise<void> {
  for (const outboxMessageId of ids) {
    try {
      await api.actions.enqueue(
        "outbox:deliver",
        { outboxMessageId },
        "outbox",
      );
    } catch (e) {
      api.logger.warn("could not enqueue an outbox delivery", {
        outboxMessageId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * Rows due for an attempt: never tried, failed and backed off long enough, or
 * stuck in `sending` past their claim (a deliverer that died).
 * @param limit - The most to return.
 * @returns Their ids, oldest due first.
 */
export async function dueOutboxIds(limit: number): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        inArray(outboxMessages.status, ["pending", "failed", "sending"]),
        lte(outboxMessages.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(outboxMessages.nextAttemptAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** What one delivery attempt did. */
export type DeliveryOutcome = "sent" | "retry" | "undeliverable" | "skipped";

/**
 * Attempt one row. The claim is a conditional `UPDATE` into `sending`, so two
 * deliverers never post the same row at once; the claim also pushes
 * `nextAttemptAt` past the request's timeout, which is how a row whose
 * deliverer died becomes due again. **Never throws.**
 * @param id - The outbox row.
 * @returns What happened.
 */
export async function deliverOutboxMessage(
  id: number,
): Promise<DeliveryOutcome> {
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
          and(
            eq(outboxMessages.status, "sending"),
            lte(outboxMessages.nextAttemptAt, new Date()),
          ),
        ),
      ),
    )
    .returning();
  if (!row) return "skipped";

  try {
    const [owner] = await api.db.db
      .select({ secret: bots.apiCallbackSecret })
      .from(conversations)
      .innerJoin(bots, eq(bots.id, conversations.botId))
      .where(eq(conversations.id, row.conversationId))
      .limit(1);
    if (!owner?.secret) {
      return await settle(
        row,
        "undeliverable",
        "The bot has no callback secret.",
      );
    }
    const secret = decryptSecret(owner.secret);
    const body = JSON.stringify(row.payload);
    const res = await guardedFetch(row.target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Hypotenuse-Callback/1",
        "hypotenuse-signature": signCallback(
          secret,
          body,
          Math.floor(Date.now() / 1000),
        ),
        "hypotenuse-delivery": String(row.id),
      },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      return await settle(row, "sent", null);
    }
    const retryable =
      res.status === 408 || res.status === 429 || res.status >= 500;
    return await settle(
      row,
      retryable ? "retry" : "undeliverable",
      `The receiver answered HTTP ${res.status}.`,
    );
  } catch (e) {
    if (e instanceof HostRefused) {
      return settle(row, "undeliverable", e.message);
    }
    return settle(row, "retry", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Record an attempt's outcome. A retry past the window is undeliverable.
 * @param row - The row as claimed.
 * @param outcome - What the attempt decided.
 * @param error - Why, when it did not send.
 * @returns The outcome recorded.
 */
async function settle(
  row: OutboxMessage,
  outcome: "sent" | "retry" | "undeliverable",
  error: string | null,
): Promise<DeliveryOutcome> {
  const now = Date.now();
  let final = outcome;
  if (
    outcome === "retry" &&
    now - row.createdAt.getTime() > config.agents.outboxRetryWindowMs
  ) {
    final = "undeliverable";
  }
  const backoff = Math.min(
    config.agents.outboxRetryBaseMs * 2 ** Math.max(0, row.attempts - 1),
    60 * 60 * 1000,
  );
  try {
    await api.db.db
      .update(outboxMessages)
      .set(
        final === "sent"
          ? { status: "sent", sentAt: new Date(), error: null }
          : final === "retry"
            ? {
                status: "failed",
                error,
                nextAttemptAt: new Date(now + backoff),
              }
            : { status: "undeliverable", error },
      )
      .where(eq(outboxMessages.id, row.id));
  } catch (e) {
    api.logger.error("could not record an outbox attempt", {
      outboxMessageId: row.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return final;
}
