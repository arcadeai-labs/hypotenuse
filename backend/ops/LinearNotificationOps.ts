import { and, asc, eq, gte, isNotNull, lte, or } from "drizzle-orm";
import { api } from "keryx";
import { agentActivities } from "../schema/agent_activities";
import { agentSessions } from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import { type TriggerEvent, triggerEvents } from "../schema/trigger_events";
import type { WorkCancelReason } from "../schema/work_items";
import { takeLinearToken } from "./LinearBucketOps";
import { linearRequest } from "./LinearOps";
import { CLOSED_STATE_TYPES, sessionsWithLiveWork } from "./LinearWebhookOps";
import { GetIssue } from "./linear/operations";
import type { TxHandle } from "./ProjectOps";
import { afterProcessing, type HandlerResult } from "./TriggerEventOps";
import {
  cancelSessionWork,
  mergeEffects,
  noEffects,
  type WorkEffects,
} from "./WorkItemOps";

/**
 * Linear's inbox notifications to the app user (`AppUserNotification`).
 * Agent sessions, not notifications, start work — but each notification type
 * has a decided handling, recorded as the delivery's outcome, because
 * "ignored" is a decision too:
 *
 * | `action` | Handling | Outcome |
 * |---|---|---|
 * | `issueMention`, `issueCommentMention` | Linear starts (or prompts) a session for the mention itself; a check 30 s later records whether one followed | `noted`, then `mention_without_session` if none did |
 * | `issueAssignedToYou` | Hypotenuse works by **delegation**; an assignment starts nothing, and the dashboard says why | `assigned_not_delegated` |
 * | `issueUnassignedFromYou` | the issue's live turns are cancelled as a disengagement (`unassigned`), quietly | `disengaged`, or `noted` with nothing live |
 * | `issueStatusChanged` by someone other than the app | with live work on the issue, the clock reads the issue's state from Linear; `completed` or `canceled` cancels it (`issue_closed`), quietly | `noted`, then `disengaged` or `ignored` |
 * | `issueStatusChanged` by the app, or with nothing live | nothing | `ignored` |
 * | `issueEmojiReaction`, `issueCommentReaction`, `issueNewComment`, and anything else (`documentMention`, `pullRequest*`, …) | recorded only — comments are not prompts | `ignored` |
 *
 * The status notification carries no state, and processing never calls
 * Linear inside its transaction, so the read happens in the
 * `triggers:check-notifications` clock. The `Issue` data-change webhook makes
 * the same disengagements from its own fields; either subscription alone is
 * enough, and the second to arrive finds no live work.
 */

/** How long after a mention notification a session should exist. */
export const MENTION_CHECK_DELAY_MS = 30_000;

/** How long a status check keeps being retried before it is given up. */
export const STATUS_CHECK_GIVE_UP_MS = 60 * 60 * 1000;

/** How long a status check waits after a refused Linear read. */
const STATUS_RETRY_MS = 60_000;

/** The shape of the notification fields read here. */
interface NotificationFields {
  type?: unknown;
  issueId?: unknown;
  issue?: { id?: unknown } | null;
  actorId?: unknown;
}

/**
 * The issue a notification is about, if any.
 * @param payload - The delivery's body.
 * @returns The Linear issue id, or null.
 */
export function notificationIssueId(
  payload: Record<string, unknown>,
): string | null {
  const n = (payload.notification ?? {}) as NotificationFields;
  if (typeof n.issueId === "string") return n.issueId;
  return typeof n.issue?.id === "string" ? n.issue.id : null;
}

/**
 * Cancel an issue's live turns as one disengagement, quietly.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param externalIssueId - The issue.
 * @param reason - The disengagement.
 * @returns The effects, and whether any turn was live.
 */
async function disengageIssue(
  tx: TxHandle,
  integration: Integration,
  externalIssueId: string,
  reason: WorkCancelReason,
): Promise<{ effects: WorkEffects; cancelled: boolean }> {
  const effects = noEffects();
  const ids = await sessionsWithLiveWork(tx, {
    integrationId: integration.id,
    externalIssueId,
  });
  for (const id of ids) {
    mergeEffects(
      effects,
      await cancelSessionWork(tx, id, { reason, announce: false }),
    );
  }
  return { effects, cancelled: ids.length > 0 };
}

/**
 * `AppUserNotification`: one inbox notification, handled per the table above.
 * @param tx - The transaction.
 * @param event - The recorded delivery.
 * @param integration - Its integration.
 * @returns The handler's result; `checkAfter` when the clock must look again.
 */
export async function handleAppUserNotification(
  tx: TxHandle,
  event: TriggerEvent,
  integration: Integration,
): Promise<HandlerResult> {
  const payload = event.payload;
  if (
    typeof payload.appUserId === "string" &&
    payload.appUserId !== integration.externalAppUserId
  ) {
    return { outcome: "ignored", deliver: [] };
  }
  const issueId = notificationIssueId(payload);
  const actorId = (payload.notification as NotificationFields | undefined)
    ?.actorId;
  switch (event.action) {
    case "issueMention":
    case "issueCommentMention":
      return {
        outcome: "noted",
        deliver: [],
        ...(issueId
          ? { checkAfter: new Date(Date.now() + MENTION_CHECK_DELAY_MS) }
          : {}),
      };
    case "issueAssignedToYou":
      return { outcome: "assigned_not_delegated", deliver: [] };
    case "issueUnassignedFromYou": {
      if (!issueId) return { outcome: "noted", deliver: [] };
      const { effects, cancelled } = await disengageIssue(
        tx,
        integration,
        issueId,
        "unassigned",
      );
      return {
        outcome: cancelled ? "disengaged" : "noted",
        deliver: [],
        effects,
      };
    }
    case "issueStatusChanged": {
      if (!issueId || actorId === integration.externalAppUserId) {
        return { outcome: "ignored", deliver: [] };
      }
      const live = await sessionsWithLiveWork(tx, {
        integrationId: integration.id,
        externalIssueId: issueId,
      });
      return live.length > 0
        ? { outcome: "noted", deliver: [], checkAfter: new Date() }
        : { outcome: "ignored", deliver: [] };
    }
    default:
      return { outcome: "ignored", deliver: [] };
  }
}

/**
 * Whether a session on the issue started, or was prompted, since shortly
 * before the mention arrived — what Linear does for a mention by itself.
 * @param tx - The transaction.
 * @param integrationId - The integration.
 * @param externalIssueId - The issue.
 * @param since - The mention's arrival, less a minute for clock skew.
 * @returns True when a session followed.
 */
async function sessionFollowed(
  tx: TxHandle,
  integrationId: number,
  externalIssueId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .leftJoin(
      agentActivities,
      and(
        eq(agentActivities.agentSessionId, agentSessions.id),
        eq(agentActivities.direction, "inbound"),
        gte(agentActivities.createdAt, since),
      ),
    )
    .where(
      and(
        eq(agentSessions.integrationId, integrationId),
        eq(agentSessions.externalIssueId, externalIssueId),
        or(gte(agentSessions.createdAt, since), isNotNull(agentActivities.id)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** What one check decided. */
export type NotificationCheck =
  | "mention_without_session"
  | "session_followed"
  | "disengaged"
  | "still_open"
  | "deferred"
  | "given_up"
  | "skipped";

/**
 * Re-check one processed notification whose `checkAfter` is due.
 *
 * A mention is settled in one transaction. A status change first reads the
 * issue from Linear (spending a bucket token, outside any transaction), then
 * takes the row again and cancels the issue's live turns if the state is
 * `completed` or `canceled`. A refused or rate-limited read tries again a
 * minute later, for an hour.
 * @param eventId - The `trigger_events` row.
 * @param now - The current time.
 * @returns What was decided.
 */
export async function checkNotification(
  eventId: number,
  now = new Date(),
): Promise<NotificationCheck> {
  const [peek] = await api.db.db
    .select({ event: triggerEvents, integration: integrations })
    .from(triggerEvents)
    .innerJoin(integrations, eq(integrations.id, triggerEvents.integrationId))
    .where(eq(triggerEvents.id, eventId));
  if (!peek?.event.checkAfter || peek.event.checkAfter > now) return "skipped";
  const { event, integration } = peek;
  const issueId = notificationIssueId(event.payload);
  if (!issueId || integration.status !== "active") {
    await clearCheck(api.db.db, eventId);
    return "skipped";
  }

  if (event.action !== "issueStatusChanged") {
    return api.db.db.transaction(async (tx) => {
      if (!(await takeCheck(tx, eventId))) return "skipped";
      const followed = await sessionFollowed(
        tx,
        integration.id,
        issueId,
        new Date(event.receivedAt.getTime() - 60_000),
      );
      await clearCheck(
        tx,
        eventId,
        followed ? undefined : "mention_without_session",
      );
      if (!followed) {
        api.logger.warn("a mention started no agent session", {
          integrationId: integration.id,
          deliveryId: event.deliveryId,
        });
      }
      return followed ? "session_followed" : "mention_without_session";
    });
  }

  let stateType: string;
  try {
    const take = await takeLinearToken(integration.id, "normal");
    if (!take.granted) throw new Error("the request budget is spent");
    const { issue } = await linearRequest(integration, GetIssue, {
      id: issueId,
    });
    stateType = issue.state.type;
  } catch (e) {
    if (now.getTime() - event.receivedAt.getTime() > STATUS_CHECK_GIVE_UP_MS) {
      await clearCheck(api.db.db, eventId, "ignored");
      return "given_up";
    }
    api.logger.warn("reading an issue for a status notification failed", {
      eventId,
      error: e instanceof Error ? e.message : String(e),
    });
    await api.db.db
      .update(triggerEvents)
      .set({ checkAfter: new Date(now.getTime() + STATUS_RETRY_MS) })
      .where(eq(triggerEvents.id, eventId));
    return "deferred";
  }

  if (!CLOSED_STATE_TYPES.has(stateType)) {
    await clearCheck(api.db.db, eventId, "ignored");
    return "still_open";
  }
  const effects = await api.db.db.transaction(async (tx) => {
    if (!(await takeCheck(tx, eventId))) return null;
    const result = await disengageIssue(
      tx,
      integration,
      issueId,
      "issue_closed",
    );
    await clearCheck(tx, eventId, result.cancelled ? "disengaged" : "ignored");
    return result.effects;
  });
  if (!effects) return "skipped";
  await afterProcessing({ outcome: "disengaged", deliver: [], effects });
  return "disengaged";
}

/**
 * Lock a due check's row, so two clocks never act on one notification.
 * @param tx - The transaction.
 * @param eventId - The row.
 * @returns True when this transaction holds it and it is still due.
 */
async function takeCheck(tx: TxHandle, eventId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: triggerEvents.id })
    .from(triggerEvents)
    .where(
      and(eq(triggerEvents.id, eventId), isNotNull(triggerEvents.checkAfter)),
    )
    .for("update", { skipLocked: true });
  return Boolean(row);
}

/**
 * Mark a check done, with the outcome it settled on.
 * @param tx - The transaction (or the pool).
 * @param eventId - The row.
 * @param outcome - The new outcome, or undefined to keep `noted`.
 */
async function clearCheck(
  tx: TxHandle | typeof api.db.db,
  eventId: number,
  outcome?: "mention_without_session" | "disengaged" | "ignored",
): Promise<void> {
  await tx
    .update(triggerEvents)
    .set({ checkAfter: null, ...(outcome ? { outcome } : {}) })
    .where(eq(triggerEvents.id, eventId));
}

/**
 * The notifications whose check is due, oldest first.
 * @param now - The current time.
 * @param limit - The most to return.
 * @returns Event ids.
 */
export async function dueNotificationChecks(
  now = new Date(),
  limit = 50,
): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: triggerEvents.id })
    .from(triggerEvents)
    .where(
      and(
        isNotNull(triggerEvents.checkAfter),
        lte(triggerEvents.checkAfter, now),
      ),
    )
    .orderBy(asc(triggerEvents.checkAfter))
    .limit(limit);
  return rows.map((r) => r.id);
}
