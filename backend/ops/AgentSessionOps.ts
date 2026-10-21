import { and, eq, sql } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import {
  type ActivityContentType,
  type AgentActivity,
} from "../schema/agent_activities";
import {
  AGENT_SESSION_STATUSES,
  type AgentSession,
  type AgentSessionGuidance,
  type AgentSessionOrigin,
  type AgentSessionStatus,
  agentSessions,
} from "../schema/agent_sessions";
import type { Integration } from "../schema/integrations";
import type { TxHandle } from "./ProjectOps";

/**
 * The agent session mirror: one `agent_sessions` row per Linear agent session,
 * written from webhooks and from what the outbox delivers.
 *
 * The payload interfaces below are the slice of Linear's
 * `AgentSessionEventWebhookPayload` (`@linear/sdk/webhooks`) this module reads.
 * They are declared here rather than imported because the SDK is a test-time
 * dependency; `__tests__/linear/inject.ts` builds its fixtures from the SDK's
 * own types, so a drift between the two shows up there.
 */

/** A person (or app) as a webhook names them. */
export interface WebhookUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

/** The issue snapshot on an `agentSession`. */
export interface WebhookIssue {
  id: string;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  teamId?: string | null;
  team?: { id: string; key?: string | null } | null;
}

/** `agentSession` on an `AgentSessionEvent`. */
export interface WebhookAgentSession {
  id: string;
  status?: string | null;
  url?: string | null;
  issueId?: string | null;
  issue?: WebhookIssue | null;
  commentId?: string | null;
  comment?: { id: string } | null;
  sourceCommentId?: string | null;
  creatorId?: string | null;
  creator?: WebhookUser | null;
}

/** `agentActivity` on a `prompted` event. */
export interface WebhookAgentActivity {
  id: string;
  /** Where the schema puts the person's text. */
  content?: { type?: string; body?: string | null } & Record<string, unknown>;
  /** Where the prose docs put it. */
  body?: string | null;
  signal?: string | null;
  signalMetadata?: Record<string, unknown> | null;
  sourceCommentId?: string | null;
  userId?: string | null;
  user?: WebhookUser | null;
}

/** An `AgentSessionEvent` body, as far as the mirror reads it. */
export interface AgentSessionEventPayload {
  type: "AgentSessionEvent";
  action: string;
  organizationId: string;
  appUserId?: string;
  oauthClientId?: string;
  agentSession: WebhookAgentSession;
  agentActivity?: WebhookAgentActivity | null;
  promptContext?: string | null;
  guidance?: AgentSessionGuidance[] | null;
  previousComments?: Record<string, unknown>[] | null;
  webhookTimestamp: number;
}

/**
 * Whether a string is one of Linear's session statuses. Linear may add one;
 * an unknown value is ignored rather than written.
 * @param value - What a webhook said.
 * @returns True for a known status.
 */
export function isAgentSessionStatus(
  value: unknown,
): value is AgentSessionStatus {
  return (
    typeof value === "string" &&
    (AGENT_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The status Linear gives a session after an activity of this type. Linear
 * derives status from the last activity; the mirror applies the same rule to
 * what it has just delivered rather than waiting for a webhook that, for our
 * own writes, never comes.
 * @param contentType - The delivered activity's type.
 * @returns The implied status, or null when the type implies none.
 */
export function statusImpliedBy(
  contentType: ActivityContentType | null,
): AgentSessionStatus | null {
  switch (contentType) {
    case "thought":
    case "action":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return "complete";
    case "error":
      return "error";
    default:
      return null;
  }
}

/**
 * The columns that change with a session's status: `endedAt` is set when it
 * reaches `complete` or `error` and cleared when a prompt reopens it.
 * @param status - The new status.
 * @returns The update to apply.
 */
export function statusColumns(status: AgentSessionStatus) {
  return {
    status,
    endedAt:
      status === "complete" || status === "error"
        ? sql`coalesce(${agentSessions.endedAt}, now())`
        : null,
  };
}

/**
 * Create or refresh a session's mirror row from an `AgentSessionEvent`.
 *
 * An upsert on `externalSessionId`, so a replayed `created` (or a `prompted` for
 * a session whose `created` was lost) converges on one row. A row Hypotenuse
 * created itself before Linear's `created` arrived keeps `origin = proactive`.
 * Issue and creator fields are refreshed from every event that carries them;
 * the context fields (`promptContext`, `guidance`, `previousComments`) only
 * from `created`, the one event that sends them.
 * @param tx - The transaction.
 * @param integration - The integration the event routed to.
 * @param payload - The verified body.
 * @returns The row, and whether this call created it.
 */
export async function upsertFromWebhook(
  tx: TxHandle,
  integration: Integration,
  payload: AgentSessionEventPayload,
): Promise<{ session: AgentSession; created: boolean }> {
  const s = payload.agentSession;
  const issue = s.issue ?? null;
  const creator = s.creator ?? null;
  const commentId = s.commentId ?? s.comment?.id ?? null;
  const origin: AgentSessionOrigin = commentId ? "mention" : "delegation";
  const status = isAgentSessionStatus(s.status) ? s.status : null;
  const isCreated = payload.action === "created";

  const issueFields = {
    externalIssueId: issue?.id ?? s.issueId ?? "",
    issueIdentifier: issue?.identifier ?? null,
    issueTitle: issue?.title ?? null,
    issueUrl: issue?.url ?? null,
    externalTeamId: issue?.teamId ?? issue?.team?.id ?? null,
    teamKey: issue?.team?.key ?? null,
  };
  const contextFields = isCreated
    ? {
        promptContext: payload.promptContext ?? null,
        guidance: payload.guidance ?? null,
        previousComments: payload.previousComments ?? null,
      }
    : {};

  const [inserted] = await tx
    .insert(agentSessions)
    .values({
      projectId: integration.projectId,
      type: integration.type,
      integrationId: integration.id,
      externalSessionId: s.id,
      externalUrl: s.url ?? null,
      ...issueFields,
      externalCommentId: commentId,
      externalSourceCommentId: s.sourceCommentId ?? null,
      creatorExternalUserId: creator?.id ?? null,
      creatorName: creator?.name ?? null,
      creatorEmail: creator?.email ?? null,
      origin,
      ...contextFields,
      status: status ?? "pending",
    })
    // Two events for a session nobody has mirrored yet can be processed at
    // once (a `created` and its first `prompted` on two workers). The unique
    // index decides; the loser falls through to the update below instead of
    // failing its whole delivery.
    .onConflictDoNothing({
      target: [agentSessions.type, agentSessions.externalSessionId],
    })
    .returning();
  if (inserted) return { session: inserted, created: true };

  const [existing] = await tx
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.type, integration.type),
        eq(agentSessions.externalSessionId, s.id),
      ),
    )
    .for("update");

  const [updated] = await tx
    .update(agentSessions)
    .set({
      ...(issueFields.externalIssueId ? issueFields : {}),
      externalUrl: s.url ?? existing.externalUrl,
      externalCommentId: commentId ?? existing.externalCommentId,
      externalSourceCommentId:
        s.sourceCommentId ?? existing.externalSourceCommentId,
      ...(creator
        ? {
            creatorExternalUserId: creator.id,
            creatorName: creator.name ?? null,
            creatorEmail: creator.email ?? null,
          }
        : {}),
      ...contextFields,
      ...(status ? statusColumns(status) : {}),
    })
    .where(eq(agentSessions.id, existing.id))
    .returning();
  return { session: updated, created: false };
}

/**
 * One session of a project, or a not-found refusal — the same refusal for a
 * session that does not exist and one in another project.
 * @param projectId - The caller's project.
 * @param id - The session id.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function sessionInProject(
  projectId: number,
  id: number,
): Promise<AgentSession> {
  const [row] = await api.db.db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, id), eq(agentSessions.projectId, projectId)),
    );
  if (!row) {
    throw new TypedError({
      message: "No such agent session in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * A session as every API answers it, timestamps as epoch ms. The context
 * Linear sent (`promptContext`, `guidance`, `previousComments`) is included:
 * members of the project can already read the issue it came from.
 * @param row - The row.
 * @returns The serialized session.
 */
export function serializeAgentSession(row: AgentSession) {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    integrationId: row.integrationId,
    externalSessionId: row.externalSessionId,
    externalUrl: row.externalUrl,
    externalIssueId: row.externalIssueId,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    issueUrl: row.issueUrl,
    externalTeamId: row.externalTeamId,
    teamKey: row.teamKey,
    externalCommentId: row.externalCommentId,
    externalSourceCommentId: row.externalSourceCommentId,
    creatorExternalUserId: row.creatorExternalUserId,
    creatorName: row.creatorName,
    origin: row.origin,
    promptContext: row.promptContext,
    guidance: row.guidance,
    previousComments: row.previousComments,
    role: row.role,
    repository: row.repository,
    runnerId: row.runnerId,
    status: row.status,
    summary: row.summary,
    plan: row.plan,
    externalUrls: row.externalUrls,
    delegateRemovedAt: row.delegateRemovedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    endedAt: row.endedAt?.getTime() ?? null,
  };
}

/** {@link serializeAgentSession}'s output. */
export type SerializedAgentSession = ReturnType<typeof serializeAgentSession>;

/**
 * An activity as every API answers it, both directions, delivery state
 * included — a member watching a session should see that a write is waiting
 * or failed.
 * @param row - The row.
 * @returns The serialized activity.
 */
export function serializeActivity(row: AgentActivity) {
  return {
    id: row.id,
    agentSessionId: row.agentSessionId,
    seq: row.seq,
    direction: row.direction,
    kind: row.kind,
    contentType: row.contentType,
    content: row.content,
    ephemeral: row.ephemeral,
    signal: row.signal,
    signalMetadata: row.signalMetadata,
    clientActivityId: row.clientActivityId,
    externalActivityId: row.externalActivityId,
    externalSourceCommentId: row.externalSourceCommentId,
    externalUserId: row.externalUserId,
    priority: row.priority,
    deliveryStatus: row.deliveryStatus,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.getTime(),
    lastError: row.lastError,
    sentAt: row.sentAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

/** {@link serializeActivity}'s output. */
export type SerializedActivity = ReturnType<typeof serializeActivity>;
