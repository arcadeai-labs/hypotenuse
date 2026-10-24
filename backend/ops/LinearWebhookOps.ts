import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
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
import {
  adoptPlanningSession,
  PLANNING_DUPLICATE_RESPONSE,
} from "./ProjectPlanningOps";
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
  return ignoredBecause(
    `Hypotenuse does not act on ${event.eventType}${event.action ? ` ${event.action}` : ""}.`,
  );
}

/**
 * The result for an event nothing acts on, and why.
 * @param why - The sentence after "Ignored: ".
 * @param agentSessionId - The session it was about, when known.
 * @returns `ignored`.
 */
function ignoredBecause(
  why: string,
  agentSessionId: number | null = null,
): HandlerResult {
  return {
    outcome: "ignored",
    deliver: [],
    summary: `Ignored: ${why}`,
    agentSessionId,
  };
}

/**
 * How the event log names an issue.
 * @param identifier - The issue identifier, when known.
 * @returns `ENG-123`, or "the issue".
 */
function issueName(identifier: string | null | undefined): string {
  return identifier ?? "the issue";
}

/** The answer to a session with no issue: routing can place no turn for it. */
export const NO_ISSUE_RESPONSE =
  "I can only work from an issue for now. Delegate an issue to me, or mention me in one, and I'll pick it up there.";

/**
 * Answer a session that has no issue (one started on a project comment), and
 * queue nothing: routing, the agent tools' scope, and the worktree all start
 * from an issue.
 * @param tx - The transaction.
 * @param agentSessionId - The session.
 * @returns The result.
 */
async function answerWithoutIssue(
  tx: TxHandle,
  agentSessionId: number,
): Promise<HandlerResult> {
  await enqueueActivity(
    tx,
    agentSessionId,
    { type: "response", body: NO_ISSUE_RESPONSE },
    { priority: "ack" },
  );
  return {
    outcome: "handled",
    deliver: [agentSessionId],
    summary:
      "A session with no issue (started on a project comment): answered that work starts from an issue; no turn queued.",
    agentSessionId,
  };
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
 * | `created`, a session started for a project mention (its intent is in Redis) | as `created`, the session made a manager with the comment's text and author (`adoptPlanningSession`) |
 * | `created`, another session on a planning issue whose planning session is already adopted (its intent still in Redis), not a person's | answered with `PLANNING_DUPLICATE_RESPONSE`; no turn |
 * | `prompted`, `stop` signal | record the prompt; cancel the session's work (see `cancelSessionWork`), quoting any text typed with it |
 * | `prompted`, `continue` signal | a plain follow-up, as below; an empty body reads "continue" |
 * | `prompted`, a repository question pending | record the prompt; take it as the answer |
 * | `prompted`, otherwise | record the prompt; merge it into a queued follow-up or queue a new turn, sticky to the session's runner |
 * | `created` or `prompted`, a session with no issue (one started on a project comment) | answer that work starts from an issue; queue no turn |
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
    return ignoredBecause(
      `Hypotenuse does not act on AgentSessionEvent ${String(payload.action)}.`,
    );
  }
  if (!payload.agentSession?.id) {
    return ignoredBecause("the event names no agent session.");
  }
  if (
    payload.appUserId &&
    payload.appUserId !== integration.externalAppUserId
  ) {
    return ignoredBecause("the event is for another Linear app.");
  }

  const { session } = await upsertFromWebhook(tx, integration, payload);

  const issue = issueName(session.issueIdentifier);
  const about = { agentSessionId: session.id };
  if (payload.action === "created") {
    if (await hasOutbound(tx, session.id)) {
      return session.parentAgentSessionId !== null
        ? {
            outcome: "duplicate_of_dispatch",
            deliver: [],
            summary: `The session a manager's dispatch already started on ${issue}; nothing more to do.`,
            ...about,
          }
        : {
            outcome: "handled",
            deliver: [],
            summary: `A repeat of a session on ${issue} already acknowledged; nothing more to do.`,
            ...about,
          };
    }
    if (!session.externalIssueId) return answerWithoutIssue(tx, session.id);
    // Linear's `created` for a session a manager's dispatch started, before
    // the dispatch recorded it: it becomes the dispatch's worker session.
    const adopted = await adoptDispatchedSession(tx, integration, session);
    if (adopted?.kind === "duplicate") {
      return {
        outcome: "duplicate_of_dispatch",
        deliver: [],
        summary: `Another session on ${issue}, whose dispatch already has one; left alone.`,
        ...about,
      };
    }
    if (adopted) {
      // The dispatch's turn, when it queued one (a sibling already holding
      // the issue's dispatch means it did not).
      const [turn] = await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.agentSessionId, session.id))
        .orderBy(desc(workItems.id))
        .limit(1);
      return {
        outcome: "handled",
        deliver: [...adopted.effects.deliver],
        effects: adopted.effects,
        summary: `Adopted as the worker session a manager's dispatch started on ${issue}.`,
        ...about,
        workItemId: turn?.id ?? null,
      };
    }
    // A session started for a project mention is a manager, with the
    // comment's text and author; routing then decides no other role.
    const planning = await adoptPlanningSession(tx, integration, session);
    if (planning?.kind === "duplicate") {
      await enqueueActivity(
        tx,
        session.id,
        { type: "response", body: PLANNING_DUPLICATE_RESPONSE },
        { priority: "ack" },
      );
      return {
        outcome: "handled",
        deliver: [session.id],
        summary: `Another session on ${issue}, whose planning session already started; answered with a pointer to it, no turn queued.`,
        ...about,
      };
    }
    const planned = planning?.session ?? session;
    await enqueueActivity(
      tx,
      planned.id,
      { type: "thought", body: ackBody(planned.issueIdentifier) },
      { priority: "ack" },
    );
    const item = await createSessionCreatedItem(tx, planned);
    const effects = noEffects();
    effects.route = true;
    return {
      outcome: "handled",
      deliver: [session.id],
      effects,
      summary: `Started a session on ${issue}, acknowledged it, and queued its first turn for routing.`,
      ...about,
      workItemId: item.id,
    };
  }

  const activity = payload.agentActivity ?? null;
  if (!activity?.id) {
    return ignoredBecause("the prompt carries no activity.", session.id);
  }
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
  if (!recorded.created) {
    return {
      outcome: "handled",
      deliver: [],
      summary: `A prompt on ${issue} already recorded; nothing more to do.`,
      ...about,
    };
  }

  if (!session.externalIssueId) return answerWithoutIssue(tx, session.id);

  if (signal === "stop") {
    const effects = await cancelSessionWork(tx, session.id, {
      reason: "stop",
      announce: true,
      said: body,
    });
    return {
      outcome: "handled",
      deliver: [...effects.deliver],
      effects,
      summary: `Stop on ${issue}: cancelled the session's work.`,
      ...about,
    };
  }
  // `continue` is in Linear's schema and not its docs: it is read as a plain
  // prompt (its body, or the word), never as a resume of a stopped session.
  const work = await followUp(
    tx,
    session.id,
    recorded.row.id,
    signal === "continue" && !body.trim() ? "continue" : body,
  );
  return {
    outcome: "handled",
    deliver: [...work.effects.deliver],
    effects: work.effects,
    summary: work.summary,
    ...about,
    workItemId: work.workItemId,
  };
}

/** What a follow-up did, for the event log. */
interface FollowUpResult {
  effects: WorkEffects;
  summary: string;
  workItemId: number | null;
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
 * @returns The effects to apply, and what was done.
 */
async function followUp(
  tx: TxHandle,
  agentSessionId: number,
  activityId: number,
  body: string,
): Promise<FollowUpResult> {
  const session = await lockSession(tx, agentSessionId);
  const issue = issueName(session.issueIdentifier);
  if (session.pendingRepositoryChoice) {
    return {
      effects: await answerRepositoryChoice(tx, session, body),
      summary: `Took the follow-up on ${issue} as the answer to which repository to use.`,
      workItemId: null,
    };
  }
  const answered = await answerWaitingTurn(tx, session.id, {
    activityId,
    body,
  });
  if (answered) {
    return {
      effects: answered,
      summary: `Delivered the follow-up on ${issue} to the running turn, as the answer to its question.`,
      workItemId: null,
    };
  }
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
  const summary = work.merged
    ? `Merged the follow-up on ${issue} into the turn already queued.`
    : work.behind
      ? `Queued the follow-up on ${issue} as a new turn, behind one that has not ended.`
      : `Queued the follow-up on ${issue} as a new turn for routing.`;
  return { effects, summary, workItemId: work.item.id };
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
    return {
      outcome: "handled",
      deliver: [],
      effects: undelivered(effects),
      summary: `Team access changed; ${plural(cut.length, "session")} on a removed team ended.`,
    };
  }
  return {
    outcome: "handled",
    deliver: [],
    summary: "Team access changed; the integration's team list follows.",
  };
}

/**
 * A count and a noun, pluralized.
 * @param n - The count.
 * @param noun - The singular noun.
 * @returns `1 session`, `2 sessions`.
 */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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
  const live = await sessionsWithLiveWork(tx, {
    integrationId: integration.id,
  });
  for (const id of live) {
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
    summary: `The app was uninstalled in Linear: the integration is revoked and ${plural(live.length, "session")} with live work cancelled.`,
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
  if (typeof data.id !== "string") {
    return ignoredBecause("the issue event names no issue.");
  }
  const issue = issueName(
    typeof data.identifier === "string" ? data.identifier : null,
  );
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
  if (!undelegated && !closed) {
    return ignoredBecause(
      `a change to ${issue} that neither removed @hypotenuse as delegate nor closed it.`,
    );
  }

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
  const live = await sessionsWithLiveWork(tx, {
    integrationId: integration.id,
    externalIssueId: data.id,
  });
  for (const id of live) {
    mergeEffects(
      effects,
      await cancelSessionWork(tx, id, {
        reason: undelegated ? "delegate_removed" : "issue_closed",
        announce: false,
      }),
    );
  }
  const why = undelegated
    ? `@hypotenuse is no longer the delegate on ${issue}`
    : payload.action === "remove"
      ? `${issue} was deleted`
      : `${issue} was closed`;
  return {
    outcome: "handled",
    deliver: [...effects.deliver],
    effects,
    summary:
      live.length === 0
        ? `${capitalize(why)}; no work was running.`
        : `${capitalize(why)}: cancelled the work of ${plural(live.length, "session")}.`,
    // One session is the usual case; several on one issue link to none.
    agentSessionId: live.length === 1 ? live[0] : null,
  };
}

/**
 * A sentence's first letter in capitals.
 * @param text - The sentence.
 * @returns It, capitalized.
 */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
