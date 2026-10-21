import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { api, config } from "keryx";
import {
  ACTIVITY_SIGNALS,
  type ActivitySignal,
} from "../schema/agent_activities";
import { agentSessions } from "../schema/agent_sessions";
import {
  type LinearEvent,
  type LinearEventOutcome,
  linearEvents,
} from "../schema/linear_events";
import {
  type LinearInstallation,
  linearInstallations,
} from "../schema/linear_installations";
import {
  enqueueActivity,
  failPending,
  recordInboundPrompt,
  scheduleDelivery,
} from "./ActivityOutboxOps";
import {
  type AgentSessionEventPayload,
  upsertFromWebhook,
  type WebhookAgentActivity,
} from "./AgentSessionOps";
import { catalogKey } from "./LinearCatalogOps";
import { rateLimitKey } from "./LinearOps";
import { getAdminUserIds } from "./MembershipOps";
import { enqueueNotification } from "./NotificationOps";
import type { TxHandle } from "./ProjectOps";

/**
 * Linear's webhooks: verifying a delivery, and what each one does once it is
 * recorded.
 *
 * Ingress (`webhooks:linear`) only verifies and records; everything here that
 * changes state runs later, in `linear:process-event`, so the endpoint answers
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
 * The live installation a delivery belongs to, by workspace id. Revoked rows
 * never match: a disconnected workspace's deliveries are recorded and ignored.
 * @param organizationId - The body's `organizationId`.
 * @returns The installation, or null.
 */
export async function installationForOrganization(
  organizationId: unknown,
): Promise<LinearInstallation | null> {
  if (typeof organizationId !== "string" || !organizationId) return null;
  const [row] = await api.db.db
    .select()
    .from(linearInstallations)
    .where(
      and(
        eq(linearInstallations.organizationId, organizationId),
        ne(linearInstallations.status, "revoked"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What processing one event decided. */
export interface ProcessResult {
  outcome: LinearEventOutcome;
  /** Sessions whose outbox gained rows. */
  deliver: number[];
  /** An installation that was just revoked, whose Redis state should go. */
  revokedInstallationId?: number;
}

/** A handler's answer before it is written to the event row. */
type HandlerResult = Omit<ProcessResult, "outcome"> & {
  outcome: Exclude<LinearEventOutcome, "pending" | "failed">;
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
 * @param eventId - The `linear_events` row.
 * @returns What was done, or null when the event was already processed (or
 *   another process holds it).
 */
export async function processLinearEvent(
  eventId: number,
): Promise<ProcessResult | null> {
  try {
    return await api.db.db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(linearEvents)
        .where(
          and(eq(linearEvents.id, eventId), isNull(linearEvents.processedAt)),
        )
        .for("update", { skipLocked: true });
      if (!event) return null;

      // Unlocked: only the handlers that change the installation lock it, so
      // a token refresh holding the row does not stall every session event.
      const installation = event.installationId
        ? ((
            await tx
              .select()
              .from(linearInstallations)
              .where(eq(linearInstallations.id, event.installationId))
          )[0] ?? null)
        : null;

      const result: HandlerResult =
        installation && installation.status !== "revoked"
          ? await dispatch(tx, event, installation)
          : { outcome: "unknown_installation", deliver: [] };

      await tx
        .update(linearEvents)
        .set({ processedAt: new Date(), outcome: result.outcome })
        .where(eq(linearEvents.id, event.id));
      return result;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    api.logger.error("processing a Linear webhook failed", {
      eventId,
      error: message,
    });
    await api.db.db
      .update(linearEvents)
      .set({ processedAt: new Date(), outcome: "failed", error: message })
      .where(
        and(eq(linearEvents.id, eventId), isNull(linearEvents.processedAt)),
      );
    return { outcome: "failed", deliver: [] };
  }
}

/**
 * Route an event to its handler by `type` and `action`. Anything unrecognized
 * is `ignored` — Linear types `action` as a free string and adds values.
 * @param tx - The transaction.
 * @param event - The recorded delivery.
 * @param installation - Its installation.
 * @returns The handler's result.
 */
async function dispatch(
  tx: TxHandle,
  event: LinearEvent,
  installation: LinearInstallation,
): Promise<HandlerResult> {
  const payload = event.payload;
  switch (event.eventType) {
    case "AgentSessionEvent":
      return handleAgentSessionEvent(
        tx,
        installation,
        payload as unknown as AgentSessionEventPayload,
      );
    case "PermissionChange":
      return event.action === "teamAccessChanged"
        ? handlePermissionChange(tx, installation, payload)
        : ignored(event);
    case "OAuthApp":
      return event.action === "revoked"
        ? handleOAuthAppRevoked(tx, installation)
        : ignored(event);
    case "Issue":
      return handleIssueEvent(tx, installation, payload);
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
function ignored(event: LinearEvent): HandlerResult {
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
 * @param installation - The installation.
 * @param payload - The body.
 * @returns The result.
 */
export async function handleAgentSessionEvent(
  tx: TxHandle,
  installation: LinearInstallation,
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
    (payload.appUserId && payload.appUserId !== installation.appUserId)
  ) {
    return { outcome: "ignored", deliver: [] };
  }

  const { session } = await upsertFromWebhook(tx, installation, payload);

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
    linearActivityId: activity.id,
    body: promptBody(activity),
    signal,
    signalMetadata: activity.signalMetadata ?? null,
    sourceCommentId: activity.sourceCommentId ?? null,
    linearUserId: activity.userId ?? activity.user?.id ?? null,
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
 * teams `@hypotenuse` can see. The installation's team list follows; sessions
 * on a removed team are marked `error` here, and their unsent activities
 * failed, because the app can no longer write to them.
 * @param tx - The transaction.
 * @param installation - The installation.
 * @param payload - The body.
 * @returns The result.
 */
export async function handlePermissionChange(
  tx: TxHandle,
  installation: LinearInstallation,
  payload: Record<string, unknown>,
): Promise<HandlerResult> {
  const added = strings(payload.addedTeamIds);
  const removed = new Set(strings(payload.removedTeamIds));
  const [current] = await tx
    .select({ teamIds: linearInstallations.teamIds })
    .from(linearInstallations)
    .where(eq(linearInstallations.id, installation.id))
    .for("update");
  const teamIds = [...new Set([...current.teamIds, ...added])].filter(
    (id) => !removed.has(id),
  );
  await tx
    .update(linearInstallations)
    .set({
      teamIds,
      ...(typeof payload.canAccessAllPublicTeams === "boolean"
        ? { canAccessAllPublicTeams: payload.canAccessAllPublicTeams }
        : {}),
    })
    .where(eq(linearInstallations.id, installation.id));

  if (removed.size > 0) {
    const cut = await tx
      .update(agentSessions)
      .set({ status: "error", endedAt: new Date() })
      .where(
        and(
          eq(agentSessions.installationId, installation.id),
          inArray(agentSessions.teamId, [...removed]),
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
 * Linear. The installation is `revoked` with its tokens forgotten — exactly
 * what `linear:disconnect` leaves — every unsent activity fails, and the
 * project's admins are told.
 * @param tx - The transaction.
 * @param installation - The installation.
 * @returns The result.
 */
export async function handleOAuthAppRevoked(
  tx: TxHandle,
  installation: LinearInstallation,
): Promise<HandlerResult> {
  await tx
    .update(linearInstallations)
    .set({
      status: "revoked",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      accessTokenLastFour: "",
      accessTokenExpiresAt: null,
      refreshError: null,
      refreshFailedAt: null,
    })
    .where(eq(linearInstallations.id, installation.id));
  await failPending(
    tx,
    { installationId: installation.id },
    "installation unavailable",
  );
  await enqueueNotification(tx, {
    projectId: installation.projectId,
    userIds: await getAdminUserIds(tx, installation.projectId),
    template: "linear-revoked",
    payload: { organizationName: installation.organizationName },
    linkPath: "/settings/linear",
  });
  return {
    outcome: "handled",
    deliver: [],
    revokedInstallationId: installation.id,
  };
}

/**
 * `Issue` data events. The one this reads: `@hypotenuse` stopped being the
 * issue's delegate — a person un-delegated it, or dismissed the session, which
 * removes the delegate. Its sessions on the issue are marked
 * `delegateRemovedAt`, which cancellation reads. Every other issue change is
 * `ignored`.
 * @param tx - The transaction.
 * @param installation - The installation.
 * @param payload - The body: `data` is the issue now, `updatedFrom` the
 *   changed fields' previous values.
 * @returns The result.
 */
export async function handleIssueEvent(
  tx: TxHandle,
  installation: LinearInstallation,
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
    updatedFrom.delegateId === installation.appUserId;
  const isOurs = data.delegateId === installation.appUserId;
  if (payload.action !== "update" || !wasOurs || isOurs) {
    return { outcome: "ignored", deliver: [] };
  }
  if (typeof data.id !== "string") return { outcome: "ignored", deliver: [] };

  await tx
    .update(agentSessions)
    .set({ delegateRemovedAt: new Date() })
    .where(
      and(
        eq(agentSessions.installationId, installation.id),
        eq(agentSessions.linearIssueId, data.id),
        isNull(agentSessions.delegateRemovedAt),
      ),
    );
  return { outcome: "handled", deliver: [] };
}

/**
 * After an event commits: send what it enqueued, and drop what Redis caches
 * for an installation it revoked.
 * @param result - What processing did.
 */
export async function afterProcessing(result: ProcessResult): Promise<void> {
  await scheduleDelivery(result.deliver);
  if (result.revokedInstallationId) {
    await api.redis.redis.del(
      catalogKey(result.revokedInstallationId),
      rateLimitKey(result.revokedInstallationId),
    );
  }
}
