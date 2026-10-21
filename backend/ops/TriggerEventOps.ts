import { and, eq, isNull } from "drizzle-orm";
import { api } from "keryx";
import { integrations } from "../schema/integrations";
import {
  type TriggerEventOutcome,
  triggerEvents,
} from "../schema/trigger_events";
import { scheduleDelivery } from "./ActivityOutboxOps";
import { catalogKey } from "./LinearCatalogOps";
import { rateLimitKey } from "./LinearOps";
import { handleLinearEvent } from "./LinearWebhookOps";
import { applyEffects, type WorkEffects } from "./WorkItemOps";

/**
 * Processing a recorded trigger delivery, whatever system sent it: take the
 * `trigger_events` row once, hand it to its type's handler inside one
 * transaction, and record the outcome. The type's own module decides what
 * the delivery means (`LinearWebhookOps.handleLinearEvent`).
 */

/** What processing one event decided. */
export interface ProcessResult {
  outcome: TriggerEventOutcome;
  /** Sessions whose outbox gained rows. */
  deliver: number[];
  /** An integration that was just revoked, whose Redis state should go. */
  revokedIntegrationId?: number;
  /** Work routing's frames and routing pass, for after the commit. */
  effects?: WorkEffects;
}

/** A handler's answer before it is written to the event row. */
export type HandlerResult = Omit<ProcessResult, "outcome"> & {
  outcome: Exclude<TriggerEventOutcome, "pending" | "failed">;
};

/**
 * Process one recorded delivery, once.
 *
 * The event row is taken `FOR UPDATE SKIP LOCKED` and only while unprocessed,
 * so the job and the sweep clock can both reach for it and exactly one does the
 * work. Everything the handler writes, and the outcome, commit together. A
 * handler that throws leaves the row `failed` with the error, and processed: a
 * delivery that fails the same way every time must not run every five seconds
 * forever.
 * @param eventId - The `trigger_events` row.
 * @returns What was done, or null when the event was already processed (or
 *   another process holds it).
 */
export async function processTriggerEvent(
  eventId: number,
): Promise<ProcessResult | null> {
  try {
    return await api.db.db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(triggerEvents)
        .where(
          and(eq(triggerEvents.id, eventId), isNull(triggerEvents.processedAt)),
        )
        .for("update", { skipLocked: true });
      if (!event) return null;

      // Unlocked: only the handlers that change the integration lock it, so a
      // token refresh holding the row does not stall every session event.
      const integration = event.integrationId
        ? ((
            await tx
              .select()
              .from(integrations)
              .where(eq(integrations.id, event.integrationId))
          )[0] ?? null)
        : null;

      let result: HandlerResult;
      if (!integration || integration.status === "revoked") {
        result = { outcome: "unknown_integration", deliver: [] };
      } else {
        switch (event.type) {
          case "linear":
            result = await handleLinearEvent(tx, event, integration);
            break;
        }
      }

      await tx
        .update(triggerEvents)
        .set({ processedAt: new Date(), outcome: result.outcome })
        .where(eq(triggerEvents.id, event.id));
      return result;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    api.logger.error("processing a trigger webhook failed", {
      eventId,
      error: message,
    });
    await api.db.db
      .update(triggerEvents)
      .set({ processedAt: new Date(), outcome: "failed", error: message })
      .where(
        and(eq(triggerEvents.id, eventId), isNull(triggerEvents.processedAt)),
      );
    return { outcome: "failed", deliver: [] };
  }
}

/**
 * After an event commits: send what it enqueued, wake the runners and the
 * routing pass it asked for, and drop what Redis caches for an integration
 * it revoked.
 * @param result - What processing did.
 */
export async function afterProcessing(result: ProcessResult): Promise<void> {
  await scheduleDelivery(result.deliver);
  if (result.effects) {
    await applyEffects({ ...result.effects, deliver: new Set() });
  }
  if (result.revokedIntegrationId) {
    await api.redis.redis.del(
      catalogKey(result.revokedIntegrationId),
      rateLimitKey(result.revokedIntegrationId),
    );
  }
}
