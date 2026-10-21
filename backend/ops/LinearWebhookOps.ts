import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { api, config } from "keryx";
import {
  ACTIVITY_SIGNALS,
  type ActivitySignal,
} from "../schema/agent_activities";
import { agentSessions } from "../schema/agent_sessions";
import { type Integration, integrations } from "../schema/integrations";
import type { TriggerEvent } from "../schema/trigger_events";
import {
  enqueueActivity,
  failPending,
  recordInboundPrompt,
} from "./ActivityOutboxOps";
import {
  type AgentSessionEventPayload,
  upsertFromWebhook,
  type WebhookAgentActivity,
} from "./AgentSessionOps";
import { getAdminUserIds } from "./MembershipOps";
import { enqueueNotification } from "./NotificationOps";
import type { TxHandle } from "./ProjectOps";
import type { HandlerResult } from "./TriggerEventOps";

/**
 * Linear's webhooks: verifying a delivery, and what each one does once it is
 * recorded.
 *
 * Ingress (`webhooks:linear`) only verifies and records; everything here that
 * changes state runs later, in `triggers:process-event`, so the endpoint answers
 * well inside Linear's five seconds whatever the work costs.
 */

/** What every acknowledgement says while no runner can pick the work up. */
export const ACK_BODY = "Received.";

/**
 * The interim ending: there is nothing to route work to yet, so a session is
 * acknowledged and then told so, rather than left looking unresponsive. Work
 * routing replaces this with real work.
 */
export const NO_RUNNER_BODY = "No runner is connected for this project yet.";

/** The answer to a stop signal when nothing was running to stop. */
export const STOPPED_BODY = "Stopped. Nothing was running.";

/**
 * The clock the timestamp check reads. Production never changes it; the test
 * harness points it at finear's virtual clock, whose deliveries are stamped in
 * virtual time.
 */
export const webhookClock = { now: (): number => Date.now() };

/**
 * Whether `Linear-Signature` is the HMAC-SHA256 of these exact bytes under one
 * of the signing secrets — the current one, or the one being rotated out while
 * `LINEAR_WEBHOOK_SECRET_PREVIOUS` is set.
 *
 * Constant-time on equal-length buffers: this is a comparison against a
 * secret, so how long it takes to fail must not say how much matched.
 * @param raw - The body exactly as it arrived.
 * @param header - The `Linear-Signature` header, hex.
 * @param secrets - The secrets to try; empty ones are skipped.
 * @returns True when one secret signs the body.
 */
export function verifySignature(
  raw: Uint8Array,
  header: string | null,
  secrets: string[] = [
    config.linear.webhookSecret,
    config.linear.webhookSecretPrevious,
  ],
): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const presented = Buffer.from(header, "hex");
  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(raw).digest();
    // Every secret is compared, so the time taken does not say which matched.
    if (timingSafeEqual(presented, expected)) matched = true;
  }
  return matched;
}

/**
 * Whether the body's signed `webhookTimestamp` is within the tolerance of now.
 * The `Linear-Timestamp` header is not read: only the body is signed, so only
 * the body says when Linear sent it.
 * @param body - The parsed body.
 * @param now - The current time, epoch ms.
 * @param toleranceMs - How far either way is accepted.
 * @returns True when fresh.
 */
export function checkTimestamp(
  body: { webhookTimestamp?: unknown },
  now = webhookClock.now(),
  toleranceMs = config.linear.webhookToleranceMs,
): boolean {
  const ts = body.webhookTimestamp;
  return (
    typeof ts === "number" &&
    Number.isFinite(ts) &&
    Math.abs(now - ts) <= toleranceMs
  );
}

/**
 * The text of a person's prompt. Linear's schema puts it at
 * `agentActivity.content.body`; its prose docs say `agentActivity.body`. Both
 * are read, the schema's first.
 * @param activity - The `agentActivity` of a `prompted` event.
 * @returns The text, or an empty string when neither is present.
 */
export function promptBody(
  activity: WebhookAgentActivity | null | undefined,
): string {
  const fromContent = activity?.content?.body;
  if (typeof fromContent === "string") return fromContent;
  return typeof activity?.body === "string" ? activity.body : "";
}

/**
 * Do what one recorded Linear delivery asks, routing by its event type and
 * `action`. Anything unrecognized is `ignored` — Linear types `action` as a
 * free string and adds values. Called by `processTriggerEvent` for
 * `type = linear`, inside its transaction.
 * @param tx - The transaction.
 * @param event - The recorded delivery.
 * @param integration - Its integration.
 * @returns The handler's result.
 */
export async function handleLinearEvent(
  tx: TxHandle,
  event: TriggerEvent,
  integration: Integration,
): Promise<HandlerResult> {
  const payload = event.payload;
  switch (event.eventType) {
    case "AgentSessionEvent":
      return handleAgentSessionEvent(
        tx,
        integration,
        payload as unknown as AgentSessionEventPayload,
      );
    case "PermissionChange":
      return event.action === "teamAccessChanged"
        ? handlePermissionChange(tx, integration, payload)
        : ignored(event);
    case "OAuthApp":
      return event.action === "revoked"
        ? handleOAuthAppRevoked(tx, integration)
        : ignored(event);
    case "Issue":
      return handleIssueEvent(tx, integration, payload);
    case "AppUserNotification":
      // Recorded for the dashboard. Sessions, not notifications, start work.
      return { outcome: "handled", deliver: [] };
    default:
      return ignored(event);
  }
}

/**
 * The result for an event nothing acts on, logged so a new Linear type or
 * action is noticed.
 * @param event - The event.
 * @returns `ignored`.
 */
function ignored(event: TriggerEvent): HandlerResult {
  if (event.eventType === "AgentSessionEvent") {
    api.logger.warn("an AgentSessionEvent action Hypotenuse does not know", {
      deliveryId: event.deliveryId,
      action: event.action,
    });
  }
  return { outcome: "ignored", deliver: [] };
}

/**
 * Whether a session already has anything outbound — an acknowledgement is
 * sent once per session, however many times Linear says `created`.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns True when an outbound row exists.
 */
async function hasOutbound(
  tx: TxHandle,
  agentSessionId: number,
): Promise<boolean> {
  const [row] = await tx
    .execute<{ exists: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM agent_activities WHERE agent_session_id = ${agentSessionId} AND direction = 'outbound') AS "exists"`,
    )
    .then((r) => r.rows);
  return Boolean(row?.exists);
}

/**
 * `AgentSessionEvent`: the mirror, the acknowledgement, and the interim
 * answers.
 *
 * | Action | Effect |
 * |---|---|
 * | `created` | upsert the session; enqueue the `ack` thought, then the no-runner `error` |
 * | `prompted`, `stop` signal | record the prompt; answer a `response` that nothing was running |
 * | `prompted`, otherwise | record the prompt; answer the no-runner `error` |
 * | anything else | `ignored` |
 *
 * An event for another app user (never expected: one webhook per app) is
 * ignored rather than mirrored into the wrong project.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param payload - The body.
 * @returns The result.
 */
export async function handleAgentSessionEvent(
  tx: TxHandle,
  integration: Integration,
  payload: AgentSessionEventPayload,
): Promise<HandlerResult> {
  if (payload.action !== "created" && payload.action !== "prompted") {
    api.logger.warn("an AgentSessionEvent action Hypotenuse does not know", {
      action: payload.action,
    });
    return { outcome: "ignored", deliver: [] };
  }
  if (
    !payload.agentSession?.id ||
    (payload.appUserId && payload.appUserId !== integration.externalAppUserId)
  ) {
    return { outcome: "ignored", deliver: [] };
  }

  const { session } = await upsertFromWebhook(tx, integration, payload);

  if (payload.action === "created") {
    if (await hasOutbound(tx, session.id)) {
      return { outcome: "handled", deliver: [] };
    }
    await enqueueActivity(
      tx,
      session.id,
      { type: "thought", body: ACK_BODY },
      { priority: "ack" },
    );
    await enqueueActivity(tx, session.id, {
      type: "error",
      body: NO_RUNNER_BODY,
    });
    return { outcome: "handled", deliver: [session.id] };
  }

  const activity = payload.agentActivity ?? null;
  if (!activity?.id) return { outcome: "ignored", deliver: [] };
  const signal = (ACTIVITY_SIGNALS as readonly string[]).includes(
    activity.signal ?? "",
  )
    ? (activity.signal as ActivitySignal)
    : null;
  const recorded = await recordInboundPrompt(tx, session.id, {
    externalActivityId: activity.id,
    body: promptBody(activity),
    signal,
    signalMetadata: activity.signalMetadata ?? null,
    externalSourceCommentId: activity.sourceCommentId ?? null,
    externalUserId: activity.userId ?? activity.user?.id ?? null,
  });
  if (!recorded.created) return { outcome: "handled", deliver: [] };

  if (signal === "stop") {
    await enqueueActivity(
      tx,
      session.id,
      { type: "response", body: STOPPED_BODY },
      { priority: "ack" },
    );
  } else {
    await enqueueActivity(tx, session.id, {
      type: "error",
      body: NO_RUNNER_BODY,
    });
  }
  return { outcome: "handled", deliver: [session.id] };
}

/**
 * A list of strings from a payload field, or an empty list.
 * @param value - The field.
 * @returns Its strings.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * `PermissionChange` / `teamAccessChanged`: a workspace admin changed which
 * teams `@hypotenuse` can see. The integration's team list follows; sessions
 * on a removed team are marked `error` here, and their unsent activities
 * failed, because the app can no longer write to them.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param payload - The body.
 * @returns The result.
 */
export async function handlePermissionChange(
  tx: TxHandle,
  integration: Integration,
  payload: Record<string, unknown>,
): Promise<HandlerResult> {
  const added = strings(payload.addedTeamIds);
  const removed = new Set(strings(payload.removedTeamIds));
  const [current] = await tx
    .select({ details: integrations.details })
    .from(integrations)
    .where(eq(integrations.id, integration.id))
    .for("update");
  const teamIds = [...new Set([...current.details.teamIds, ...added])].filter(
    (id) => !removed.has(id),
  );
  await tx
    .update(integrations)
    .set({
      details: {
        ...current.details,
        teamIds,
        ...(typeof payload.canAccessAllPublicTeams === "boolean"
          ? { canAccessAllPublicTeams: payload.canAccessAllPublicTeams }
          : {}),
      },
    })
    .where(eq(integrations.id, integration.id));

  if (removed.size > 0) {
    const cut = await tx
      .update(agentSessions)
      .set({ status: "error", endedAt: new Date() })
      .where(
        and(
          eq(agentSessions.integrationId, integration.id),
          inArray(agentSessions.externalTeamId, [...removed]),
          notInArray(agentSessions.status, ["complete", "error"]),
        ),
      )
      .returning({ id: agentSessions.id });
    for (const { id } of cut) {
      await failPending(tx, { agentSessionId: id }, "team access removed");
    }
  }
  return { outcome: "handled", deliver: [] };
}

/**
 * `OAuthApp` / `revoked`: the app was uninstalled from the workspace in
 * Linear. The integration is `revoked` with its tokens forgotten — exactly
 * what `integration:disconnect` leaves — every unsent activity fails, and the
 * project's admins are told.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @returns The result.
 */
export async function handleOAuthAppRevoked(
  tx: TxHandle,
  integration: Integration,
): Promise<HandlerResult> {
  await tx
    .update(integrations)
    .set({
      status: "revoked",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      accessTokenLastFour: "",
      accessTokenExpiresAt: null,
      refreshError: null,
      refreshFailedAt: null,
    })
    .where(eq(integrations.id, integration.id));
  await failPending(
    tx,
    { integrationId: integration.id },
    "integration unavailable",
  );
  await enqueueNotification(tx, {
    projectId: integration.projectId,
    userIds: await getAdminUserIds(tx, integration.projectId),
    template: "linear-revoked",
    payload: { workspaceName: integration.workspaceName },
    linkPath: "/settings/integrations",
  });
  return {
    outcome: "handled",
    deliver: [],
    revokedIntegrationId: integration.id,
  };
}

/**
 * `Issue` data events. The one this reads: `@hypotenuse` stopped being the
 * issue's delegate — a person un-delegated it, or dismissed the session, which
 * removes the delegate. Its sessions on the issue are marked
 * `delegateRemovedAt`, which cancellation reads. Every other issue change is
 * `ignored`.
 * @param tx - The transaction.
 * @param integration - The integration.
 * @param payload - The body: `data` is the issue now, `updatedFrom` the
 *   changed fields' previous values.
 * @returns The result.
 */
export async function handleIssueEvent(
  tx: TxHandle,
  integration: Integration,
  payload: Record<string, unknown>,
): Promise<HandlerResult> {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const updatedFrom = (payload.updatedFrom ?? null) as Record<
    string,
    unknown
  > | null;
  const wasOurs =
    updatedFrom !== null &&
    "delegateId" in updatedFrom &&
    updatedFrom.delegateId === integration.externalAppUserId;
  const isOurs = data.delegateId === integration.externalAppUserId;
  if (payload.action !== "update" || !wasOurs || isOurs) {
    return { outcome: "ignored", deliver: [] };
  }
  if (typeof data.id !== "string") return { outcome: "ignored", deliver: [] };

  await tx
    .update(agentSessions)
    .set({ delegateRemovedAt: new Date() })
    .where(
      and(
        eq(agentSessions.integrationId, integration.id),
        eq(agentSessions.externalIssueId, data.id),
        isNull(agentSessions.delegateRemovedAt),
      ),
    );
  return { outcome: "handled", deliver: [] };
}
