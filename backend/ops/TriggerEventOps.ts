import {
  aliasedTable,
  and,
  desc,
  eq,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../schema/agent_sessions";
import { integrations } from "../schema/integrations";
import { runners } from "../schema/runners";
import {
  type TriggerEventOutcome,
  triggerEvents,
} from "../schema/trigger_events";
import { workItems } from "../schema/work_items";
import { scheduleDelivery } from "./ActivityOutboxOps";
import { catalogKey } from "./LinearCatalogOps";
import { rateLimitKey } from "./LinearOps";
import { handleLinearEvent } from "./LinearWebhookOps";
import { applyEffects, noEffects, type WorkEffects } from "./WorkItemOps";

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
  /** The project whose event log gained a processed row, to ping. */
  projectId?: number | null;
}

/** The summary of a delivery for a workspace no live integration holds. */
export const UNKNOWN_INTEGRATION_SUMMARY =
  "No project has this Linear workspace connected; recorded and left alone.";

/** A handler's answer before it is written to the event row. */
export type HandlerResult = Omit<ProcessResult, "outcome"> & {
  outcome: Exclude<TriggerEventOutcome, "pending" | "failed">;
  /** What it did, in one sentence, for the event log. */
  summary: string;
  /** The agent session the delivery was about. */
  agentSessionId?: number | null;
  /** The turn it queued, joined, answered, or cancelled. */
  workItemId?: number | null;
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
        result = {
          outcome: "unknown_integration",
          deliver: [],
          summary: UNKNOWN_INTEGRATION_SUMMARY,
        };
      } else {
        switch (event.type) {
          case "linear":
            result = await handleLinearEvent(tx, event, integration);
            break;
        }
      }

      await tx
        .update(triggerEvents)
        .set({
          processedAt: new Date(),
          outcome: result.outcome,
          summary: result.summary,
          agentSessionId: result.agentSessionId ?? null,
          workItemId: result.workItemId ?? null,
        })
        .where(eq(triggerEvents.id, event.id));
      return { ...result, projectId: integration?.projectId ?? null };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    api.logger.error("processing a trigger webhook failed", {
      eventId,
      error: message,
    });
    const [failed] = await api.db.db
      .update(triggerEvents)
      .set({
        processedAt: new Date(),
        outcome: "failed",
        error: message,
        summary: "Processing failed; nothing it would have done was kept.",
      })
      .where(
        and(eq(triggerEvents.id, eventId), isNull(triggerEvents.processedAt)),
      )
      .returning({ integrationId: triggerEvents.integrationId });
    return {
      outcome: "failed",
      deliver: [],
      projectId: failed?.integrationId
        ? await projectOfIntegration(failed.integrationId)
        : null,
    };
  }
}

/**
 * After an event commits: send what it enqueued, wake the runners and the
 * routing pass it asked for, tell the dashboards which sessions changed, and
 * drop what Redis caches for an integration it revoked.
 * @param result - What processing did.
 */
export async function afterProcessing(result: ProcessResult): Promise<void> {
  await scheduleDelivery(result.deliver);
  // Delivery is scheduled above; the sessions it is for changed, and the
  // dashboards hear about them with the rest of the effects.
  await applyEffects({
    ...(result.effects ?? noEffects()),
    deliver: new Set(),
    sessions: new Set([
      ...(result.effects?.sessions ?? []),
      ...(result.effects?.deliver ?? []),
      ...result.deliver,
    ]),
  });
  if (result.projectId) await publishEventsChanged(result.projectId);
  if (result.revokedIntegrationId) {
    await api.redis.redis.del(
      catalogKey(result.revokedIntegrationId),
      rateLimitKey(result.revokedIntegrationId),
    );
  }
}

/**
 * An integration's most recent webhook deliveries and when the last one
 * arrived — what the dashboard's integration card and project home show
 * about the webhook's health. Never the payload.
 * @param integrationId - The integration.
 * @param limit - How many deliveries to list.
 * @returns The last receipt time (epoch ms) and the deliveries, newest first.
 */
export async function recentDeliveries(integrationId: number, limit = 10) {
  const rows = await api.db.db
    .select({
      id: triggerEvents.id,
      eventType: triggerEvents.eventType,
      action: triggerEvents.action,
      outcome: triggerEvents.outcome,
      error: triggerEvents.error,
      receivedAt: triggerEvents.receivedAt,
      processedAt: triggerEvents.processedAt,
    })
    .from(triggerEvents)
    .where(eq(triggerEvents.integrationId, integrationId))
    .orderBy(desc(triggerEvents.receivedAt), desc(triggerEvents.id))
    .limit(limit);
  return {
    lastReceivedAt: rows[0]?.receivedAt.getTime() ?? null,
    recent: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      action: r.action,
      outcome: r.outcome,
      error: r.error,
      receivedAt: r.receivedAt.getTime(),
      processedAt: r.processedAt?.getTime() ?? null,
    })),
  };
}

/** The dashboard channel a project's event log is refreshed on. */
export const PROJECT_EVENTS_CHANNEL_PATTERN = /^project:(\d+):events$/;

/**
 * The dashboard channel for a project's event log.
 * @param projectId - The project.
 * @returns `project:<id>:events`.
 */
export function projectEventsChannel(projectId: number): string {
  return `project:${projectId}:events`;
}

/**
 * Tell a project's dashboards its event log changed: a delivery was recorded
 * or processed. Content-free — the client re-reads through
 * `trigger-event:list`. Never throws.
 * @param projectId - The project.
 */
export async function publishEventsChanged(projectId: number): Promise<void> {
  try {
    await api.pubsub.broadcast(
      projectEventsChannel(projectId),
      JSON.stringify({ event: "events" }),
      "events",
    );
  } catch (error) {
    api.logger.warn("event log broadcast failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The project an integration belongs to.
 * @param integrationId - The integration.
 * @returns Its project id, or null when it is gone.
 */
export async function projectOfIntegration(
  integrationId: number,
): Promise<number | null> {
  const [row] = await api.db.db
    .select({ projectId: integrations.projectId })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  return row?.projectId ?? null;
}

/** The runner a turn is offered to or held by. */
const turnRunner = aliasedTable(runners, "turn_runner");

/**
 * The columns the event log reads: the delivery, the project it belongs to,
 * and how it was routed — the session's role and the rule that chose it, and
 * the turn's status and placement, read live rather than copied, so a row
 * says where its work is now. Never the payload.
 */
const eventLogColumns = {
  event: {
    id: triggerEvents.id,
    type: triggerEvents.type,
    deliveryId: triggerEvents.deliveryId,
    eventType: triggerEvents.eventType,
    action: triggerEvents.action,
    outcome: triggerEvents.outcome,
    summary: triggerEvents.summary,
    error: triggerEvents.error,
    webhookTimestamp: triggerEvents.webhookTimestamp,
    receivedAt: triggerEvents.receivedAt,
    processedAt: triggerEvents.processedAt,
    // The issue an event without a session names — an `Issue` change.
    payloadIssueIdentifier: sql<
      string | null
    >`coalesce(${triggerEvents.payload}->'data'->>'identifier', ${triggerEvents.payload}->'agentSession'->'issue'->>'identifier')`,
  },
  session: {
    id: agentSessions.id,
    issueIdentifier: agentSessions.issueIdentifier,
    issueTitle: agentSessions.issueTitle,
    status: agentSessions.status,
    role: agentSessions.role,
    routingRuleId: agentSessions.routingRuleId,
    routingRuleName: agentSessions.routingRuleName,
    parentAgentSessionId: agentSessions.parentAgentSessionId,
  },
  turn: {
    id: workItems.id,
    kind: workItems.kind,
    status: workItems.status,
    repository: workItems.repository,
    waitingReason: workItems.waitingReason,
    waitingCode: workItems.waitingCode,
    cancelReason: workItems.cancelReason,
    finishedAt: workItems.finishedAt,
  },
  runner: { id: turnRunner.id, name: turnRunner.name },
};

/**
 * The event log's query, joined, scoped to one project by its integrations,
 * newest first. A delivery for no connected workspace has no integration and
 * so belongs to no project's log.
 * @param projectId - The project.
 * @param where - Any further conditions.
 * @returns A dynamic query, for paging.
 */
export function eventLogQuery(projectId: number, where?: SQL) {
  return api.db.db
    .select(eventLogColumns)
    .from(triggerEvents)
    .innerJoin(integrations, eq(integrations.id, triggerEvents.integrationId))
    .leftJoin(agentSessions, eq(agentSessions.id, triggerEvents.agentSessionId))
    .leftJoin(workItems, eq(workItems.id, triggerEvents.workItemId))
    .leftJoin(
      turnRunner,
      eq(
        turnRunner.id,
        sql`coalesce(${workItems.runnerId}, ${workItems.offeredToRunnerId})`,
      ),
    )
    .where(and(eq(integrations.projectId, projectId), where))
    .orderBy(desc(triggerEvents.receivedAt), desc(triggerEvents.id))
    .$dynamic();
}

/** One row of {@link eventLogQuery}. */
export type EventLogRow = Awaited<ReturnType<typeof eventLogQuery>>[number];

/**
 * One event log row for a client: the delivery, what it did, and how it was
 * routed. Epoch-ms timestamps; never the payload.
 * @param row - The joined row.
 * @returns The serialized event.
 */
export function serializeTriggerEvent(row: EventLogRow) {
  const { event, session, turn, runner } = row;
  const ms = (d: Date | null) => (d ? d.getTime() : null);
  return {
    id: event.id,
    type: event.type,
    deliveryId: event.deliveryId,
    eventType: event.eventType,
    action: event.action,
    outcome: event.outcome,
    summary: event.summary,
    error: event.error,
    issueIdentifier:
      session?.issueIdentifier ?? event.payloadIssueIdentifier ?? null,
    webhookTimestamp: event.webhookTimestamp.getTime(),
    receivedAt: event.receivedAt.getTime(),
    processedAt: ms(event.processedAt),
    session: session
      ? {
          id: session.id,
          issueTitle: session.issueTitle,
          status: session.status,
          role: session.role,
          // The rule that chose the role; null with a role is the default.
          routingRule:
            session.routingRuleName !== null
              ? { id: session.routingRuleId, name: session.routingRuleName }
              : null,
          dispatched: session.parentAgentSessionId !== null,
        }
      : null,
    turn: turn
      ? {
          id: turn.id,
          kind: turn.kind,
          status: turn.status,
          repository: turn.repository,
          runner: runner ? { id: runner.id, name: runner.name } : null,
          waitingReason: turn.waitingReason,
          waitingCode: turn.waitingCode,
          cancelReason: turn.cancelReason,
          finishedAt: ms(turn.finishedAt),
        }
      : null,
  };
}

/** {@link serializeTriggerEvent}'s output. */
export type SerializedTriggerEvent = ReturnType<typeof serializeTriggerEvent>;
