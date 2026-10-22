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
import { TERMINAL_WORK_STATUSES, workItems } from "../schema/work_items";
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
import { adoptDispatchedSession } from "./DispatchOps";
import { handleAppUserNotification } from "./LinearNotificationOps";
import { getAdminUserIds } from "./MembershipOps";
import { enqueueNotification } from "./NotificationOps";
import type { TxHandle } from "./ProjectOps";
import { listRoutingRules, roleSwitchAttempt, stripPrefix } from "./RoutingOps";
import type { HandlerResult } from "./TriggerEventOps";
import {
  ackBody,
  answerWaitingTurn,
  cancelSessionWork,
  createOrMergePrompt,
  createSessionCreatedItem,
  lockSession,
  mergeEffects,
  noEffects,
  QUEUED_BEHIND_BODY,
  type WorkEffects,
} from "./WorkItemOps";
import { answerRepositoryChoice } from "./WorkRouteOps";

/**
 * Linear's webhooks: verifying a delivery, and what each one does once it is
 * recorded.
 *
 * Ingress (`webhooks:linear`) only verifies and records; everything here that
 * changes state runs later, in `triggers:process-event`, so the endpoint answers
 * well inside Linear's five seconds whatever the work costs.
 */

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
 * An IPv4 address as a 32-bit number, or null.
 * @param ip - Dotted quad.
 * @returns The number.
 */
function v4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

/**
 * Whether an address is on the webhook allowlist: an IPv4 address matches an
 * entry that is the same address or a CIDR containing it (an IPv4-mapped IPv6
 * address counts as its IPv4 form); an IPv6 address matches the same address.
 * An empty list allows everything — the check is off.
 * @param ip - The sender.
 * @param allowlist - Comma-separated entries.
 * @returns True when allowed.
 */
export function ipAllowed(ip: string, allowlist: string): boolean {
  const entries = allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  const host = ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.)/, "");
  const address = v4(host);
  return entries.some((entry) => {
    const [base, bits] = entry.split("/");
    if (address === null || v4(base) === null) return entry === host;
    const prefix = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) >>> 0 === ((v4(base) as number) & mask) >>> 0;
  });
}

/**
 * Who sent a request, for the allowlist: the socket's peer, or with
 * `trustForwarded` the last `X-Forwarded-For` entry — the one the
 * deployment's own proxy appended, which a sender cannot forge.
 * @param socketIp - The connection's peer address.
 * @param forwardedFor - The `X-Forwarded-For` header.
 * @param trustForwarded - Whether a proxy in front of us sets it.
 * @returns The address.
 */
export function webhookSender(
  socketIp: string,
  forwardedFor: string | null,
  trustForwarded = Boolean(config.linear.webhookTrustForwarded),
): string {
  if (!trustForwarded || !forwardedFor) return socketIp;
  const last = forwardedFor.split(",").at(-1)?.trim();
  return last || socketIp;
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
      return handleAppUserNotification(tx, event, integration);
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
 * `AgentSessionEvent`: the mirror, the acknowledgement, and the work.
 *
 * | Action | Effect |
 * |---|---|
 * | `created` | upsert the session; enqueue the `ack` thought and the session's first turn (routing prepares and places it) |
 * | `created`, a session a dispatch already recorded | nothing more (`duplicate_of_dispatch`) |
 * | `created`, a session a dispatch is starting (its intent is in Redis) | the dispatch's worker session and turn instead of the acknowledgement (`completeDispatch`) |
 * | `created`, another session on an issue whose dispatch already has one | nothing (`duplicate_of_dispatch`) |
 * | `prompted`, `stop` signal | record the prompt; cancel the session's work (see `cancelSessionWork`), quoting any text typed with it |
 * | `prompted`, `continue` signal | a plain follow-up, as below; an empty body reads "continue" |
 * | `prompted`, a repository question pending | record the prompt; take it as the answer |
 * | `prompted`, otherwise | record the prompt; merge it into a queued follow-up or queue a new turn, sticky to the session's runner |
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
      return {
        outcome:
          session.parentAgentSessionId !== null
            ? "duplicate_of_dispatch"
            : "handled",
        deliver: [],
      };
    }
    // Linear's `created` for a session a manager's dispatch started, before
    // the dispatch recorded it: it becomes the dispatch's worker session.
    const adopted = await adoptDispatchedSession(tx, integration, session);
    if (adopted?.kind === "duplicate") {
      return { outcome: "duplicate_of_dispatch", deliver: [] };
    }
    if (adopted) {
      return {
        outcome: "handled",
        deliver: [...adopted.effects.deliver],
        effects: adopted.effects,
      };
    }
    await enqueueActivity(
      tx,
      session.id,
      { type: "thought", body: ackBody(session.issueIdentifier) },
      { priority: "ack" },
    );
    await createSessionCreatedItem(tx, session);
    const effects = noEffects();
    effects.route = true;
    return { outcome: "handled", deliver: [session.id], effects };
  }

  const activity = payload.agentActivity ?? null;
  if (!activity?.id) return { outcome: "ignored", deliver: [] };
  const signal = (ACTIVITY_SIGNALS as readonly string[]).includes(
    activity.signal ?? "",
  )
    ? (activity.signal as ActivitySignal)
    : null;
  const body = promptBody(activity);
  const recorded = await recordInboundPrompt(tx, session.id, {
    externalActivityId: activity.id,
    body,
    signal,
    signalMetadata: activity.signalMetadata ?? null,
    externalSourceCommentId: activity.sourceCommentId ?? null,
    externalUserId: activity.userId ?? activity.user?.id ?? null,
  });
  if (!recorded.created) return { outcome: "handled", deliver: [] };

  // `continue` is in Linear's schema and not its docs: it is read as a plain
  // prompt (its body, or the word), never as a resume of a stopped session.
  const effects =
    signal === "stop"
      ? await cancelSessionWork(tx, session.id, {
          reason: "stop",
          announce: true,
          said: body,
        })
      : await followUp(
          tx,
          session.id,
          recorded.row.id,
          signal === "continue" && !body.trim() ? "continue" : body,
        );
  return { outcome: "handled", deliver: [...effects.deliver], effects };
}

/**
 * A person's follow-up, as work. A pending repository question takes it as
 * the answer, and so does a running turn waiting on a question it asked.
 * Otherwise it joins the session's queued follow-up or becomes a
 * new turn; a person typing while a turn runs is told it will be read next.
 * A role prefix for the other role does not switch roles — the role is the
 * session's for life — and the session says so.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @param activityId - The recorded inbound prompt.
 * @param body - What the person typed.
 * @returns The effects to apply.
 */
async function followUp(
  tx: TxHandle,
  agentSessionId: number,
  activityId: number,
  body: string,
): Promise<WorkEffects> {
  const session = await lockSession(tx, agentSessionId);
  if (session.pendingRepositoryChoice) {
    return answerRepositoryChoice(tx, session, body);
  }
  const answered = await answerWaitingTurn(tx, session.id, {
    activityId,
    body,
  });
  if (answered) return answered;
  const effects = noEffects();
  let text = body;
  if (session.role) {
    const rules = await listRoutingRules(tx, session.projectId);
    const attempt = roleSwitchAttempt(rules, body, session.role);
    if (attempt?.match.promptPrefix) {
      await enqueueActivity(tx, session.id, {
        type: "thought",
        body: `This session stays a **${session.role}** session — its role is fixed for its life. Mention me again with \`${attempt.match.promptPrefix}\` to start a ${attempt.role} session.`,
      });
      effects.deliver.add(session.id);
      text = stripPrefix(body, attempt.match.promptPrefix) || body;
    }
  }
  const work = await createOrMergePrompt(tx, session, {
    activityId,
    body: text,
  });
  if (work.behind) {
    await enqueueActivity(tx, session.id, {
      type: "thought",
      body: QUEUED_BEHIND_BODY,
    });
    effects.deliver.add(session.id);
  }
  effects.route = true;
  return effects;
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
    const effects = noEffects();
    for (const { id } of cut) {
      mergeEffects(
        effects,
        await cancelSessionWork(tx, id, {
          reason: "integration_revoked",
          announce: false,
        }),
      );
      await failPending(tx, { agentSessionId: id }, "team access removed");
    }
    return { outcome: "handled", deliver: [], effects: undelivered(effects) };
  }
  return { outcome: "handled", deliver: [] };
}

/**
 * Effects whose outbox rows were just failed: nothing to deliver, but the
 * frames and the routing pass still matter.
 * @param effects - The effects.
 * @returns The same effects with no deliveries.
 */
function undelivered(effects: WorkEffects): WorkEffects {
  return { ...effects, deliver: new Set() };
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
  const effects = noEffects();
  for (const id of await sessionsWithLiveWork(tx, {
    integrationId: integration.id,
  })) {
    mergeEffects(
      effects,
      await cancelSessionWork(tx, id, {
        reason: "integration_revoked",
        announce: false,
      }),
    );
  }
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
    effects: undelivered(effects),
  };
}

/**
 * The sessions with a turn that has not ended, of an integration or on one
 * issue.
 * @param tx - The transaction.
 * @param where - The integration, and optionally the issue.
 * @returns Session ids.
 */
export async function sessionsWithLiveWork(
  tx: TxHandle,
  where: { integrationId: number; externalIssueId?: string },
): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ id: agentSessions.id })
    .from(agentSessions)
    .innerJoin(workItems, eq(workItems.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.integrationId, where.integrationId),
        where.externalIssueId
          ? eq(agentSessions.externalIssueId, where.externalIssueId)
          : undefined,
        notInArray(workItems.status, [...TERMINAL_WORK_STATUSES]),
      ),
    );
  return rows.map((r) => r.id);
}

/** The state types that end an issue: the person is done with it. */
export const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * `Issue` data events. Two disengage the agent, and are handled the same way
 * — the issue's live turns are cancelled, quietly, and nothing re-engages
 * without a new prompt or delegation:
 *
 * | Change | Cancel reason |
 * |---|---|
 * | `@hypotenuse` stopped being the delegate (un-delegated, or the session dismissed, which removes the delegate) | `delegate_removed`; sessions are marked `delegateRemovedAt` |
 * | the issue moved to a `completed` or `canceled` state, or was deleted (`remove`) | `issue_closed` |
 *
 * Every other issue change is `ignored`.
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
  if (typeof data.id !== "string") return { outcome: "ignored", deliver: [] };
  const updated = payload.action === "update" && updatedFrom !== null;
  const wasOurs =
    updated &&
    "delegateId" in updatedFrom &&
    updatedFrom.delegateId === integration.externalAppUserId;
  const isOurs = data.delegateId === integration.externalAppUserId;
  const undelegated = wasOurs && !isOurs;
  const stateType = (data.state as { type?: unknown } | undefined)?.type;
  const closed =
    payload.action === "remove" ||
    (updated &&
      "stateId" in updatedFrom &&
      typeof stateType === "string" &&
      CLOSED_STATE_TYPES.has(stateType));
  if (!undelegated && !closed) return { outcome: "ignored", deliver: [] };

  if (undelegated) {
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
  }
  const effects = noEffects();
  for (const id of await sessionsWithLiveWork(tx, {
    integrationId: integration.id,
    externalIssueId: data.id,
  })) {
    mergeEffects(
      effects,
      await cancelSessionWork(tx, id, {
        reason: undelegated ? "delegate_removed" : "issue_closed",
        announce: false,
      }),
    );
  }
  return { outcome: "handled", deliver: [...effects.deliver], effects };
}
