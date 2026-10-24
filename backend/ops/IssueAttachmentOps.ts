import { and, eq, ne, sql } from "drizzle-orm";
import { api } from "keryx";
import {
  type AgentActivity,
  agentActivities,
} from "../schema/agent_activities";
import { type AgentSession, agentSessions } from "../schema/agent_sessions";
import type { Integration } from "../schema/integrations";
import type { HygieneOutcome } from "../schema/work_items";
import {
  isDuplicateIdError,
  LinearGraphQLError,
  linearRequest,
} from "./LinearOps";
import {
  AttachmentLinkGitHubPR,
  AttachmentLinkURL,
  GetIssue,
  type LinearAttachmentLinkVariables,
  type LinearWorkflowState,
  ListWorkflowStates,
  UpdateIssue,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";

/**
 * A pull request linked to a session is also linked to the session's
 * **issue**, as an attachment — the link on the session alone is invisible to
 * Linear's pull request automations, which read the issue's attachments.
 *
 * The attachment is an outbox row (`issue_attachment`) in the session's
 * sequence, enqueued beside the `addedExternalUrls` update by whichever path
 * linked the pull request (the daemon's detection or `linear_report_pr`), and
 * sent by the outbox under the session's delivery lease:
 *
 * | Step | Rule |
 * |---|---|
 * | enqueue | once per URL per issue: a row for the URL on any session of the issue, pending or sent, makes it a no-op |
 * | a GitHub pull request | `attachmentLinkGitHubPR`, so Linear's GitHub integration follows it where it reaches the repository |
 * | refused, or another forge | `attachmentLinkURL` (Linear keeps one attachment per URL per issue) |
 * | resent after a lost answer | the row's client id is the attachment's id, so Linear answers it as a duplicate: linked |
 * | the issue's first attachment, worker role | the review-state move below |
 *
 * The review-state move, once, when the issue's first pull request is
 * attached:
 *
 * | Issue | Action |
 * |---|---|
 * | completed or canceled | unchanged |
 * | already in the review state | unchanged |
 * | the team has no started state named like "In Review" | skipped; the issue stays where it is |
 * | otherwise | moved to that state (the lowest `position` of them) |
 *
 * A failed move is logged and recorded on the row, never retried, and never
 * posted to the session: an activity after the turn's response would reopen
 * it in Linear.
 */

/** How long a team's review state is cached. */
export const REVIEW_STATE_TTL_SECONDS = 600;

/** A started state is the team's review state when its name says so. */
const REVIEW_STATE_NAME = /\breview\b/i;

/** The state types a pull request must not move an issue out of. */
const FINISHED_STATE_TYPES = new Set(["completed", "canceled"]);

/** What an `issue_attachment` row carries. */
export interface IssueAttachmentContent {
  url: string;
  title: string;
  /** Set once sent: which mutation linked it. */
  linkedVia?: "github" | "url";
  /** Set once sent, when `attachmentLinkGitHubPR` was refused. */
  githubRefusal?: string;
  /** Set once sent: what the review-state move did. */
  review?: HygieneOutcome;
}

/**
 * The Redis key a team's review state is cached under.
 * @param integrationId - The integration.
 * @param teamId - Linear's team id.
 * @returns The key.
 */
export const reviewStateKey = (integrationId: number, teamId: string) =>
  `linear:review-state:${integrationId}:${teamId}`;

/**
 * Whether a URL is a GitHub pull request (`github.com/<owner>/<repo>/pull/<n>`).
 * @param url - The URL.
 * @returns True when it is.
 */
export function isGitHubPullRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return false;
  return /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(parsed.pathname);
}

/**
 * The attachment's title: "Pull request #49" when the URL ends in a number
 * (GitHub, GitLab, Bitbucket all do), else the session link's label.
 * @param url - The pull request URL.
 * @param label - The session link's label.
 * @returns The title.
 */
export function pullRequestTitle(url: string, label: string): string {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return label;
  }
  const number = /\/(\d+)\/?$/.exec(path)?.[1];
  return number ? `Pull request #${number}` : label;
}

/**
 * Queue a pull request's attachment to the session's issue, once per URL per
 * issue. Inside the caller's transaction, beside the session link.
 * @param tx - The caller's transaction.
 * @param agentSessionId - The session that linked it.
 * @param link - The session link: its label and URL.
 * @param insert - Appends the row in the session's sequence (the outbox's).
 * @returns True when a row was queued.
 */
export async function queueIssueAttachment(
  tx: TxHandle,
  agentSessionId: number,
  link: { label: string; url: string },
  insert: (content: IssueAttachmentContent) => Promise<AgentActivity>,
): Promise<boolean> {
  const [session] = await tx
    .select({
      integrationId: agentSessions.integrationId,
      externalIssueId: agentSessions.externalIssueId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId));
  if (!session) return false;
  const [existing] = await tx
    .select({ id: agentActivities.id })
    .from(agentActivities)
    .innerJoin(
      agentSessions,
      eq(agentSessions.id, agentActivities.agentSessionId),
    )
    .where(
      and(
        eq(agentSessions.integrationId, session.integrationId),
        eq(agentSessions.externalIssueId, session.externalIssueId),
        eq(agentActivities.kind, "issue_attachment"),
        sql`${agentActivities.deliveryStatus} IN ('pending', 'sent')`,
        sql`${agentActivities.content}->>'url' = ${link.url}`,
      ),
    )
    .limit(1);
  if (existing) return false;
  await insert({
    url: link.url,
    title: pullRequestTitle(link.url, link.label),
  });
  return true;
}

/**
 * A team's review state: its `started` states named like "In Review", lowest
 * `position` first, cached per team for {@link REVIEW_STATE_TTL_SECONDS}.
 * @param integration - The integration.
 * @param teamId - Linear's team id.
 * @returns The state, or null when the team has none.
 */
export async function reviewState(
  integration: Integration,
  teamId: string,
): Promise<LinearWorkflowState | null> {
  const key = reviewStateKey(integration.id, teamId);
  const cached = await api.redis.redis.get(key);
  if (cached) return JSON.parse(cached) as LinearWorkflowState | null;
  const data = await linearRequest(
    integration,
    ListWorkflowStates,
    { teamId },
    { idempotent: true },
  );
  const state =
    data.team.states.nodes
      .filter((s) => s.type === "started" && REVIEW_STATE_NAME.test(s.name))
      .sort((a, b) => a.position - b.position)[0] ?? null;
  await api.redis.redis.set(
    key,
    JSON.stringify(state),
    "EX",
    REVIEW_STATE_TTL_SECONDS,
  );
  return state;
}

/**
 * Whether another attachment of the issue was already sent — this one is not
 * its first pull request.
 * @param session - The session.
 * @param row - This row.
 * @returns True when one was.
 */
async function issueHadAttachment(
  session: AgentSession,
  row: AgentActivity,
): Promise<boolean> {
  const [sent] = await api.db.db
    .select({ id: agentActivities.id })
    .from(agentActivities)
    .innerJoin(
      agentSessions,
      eq(agentSessions.id, agentActivities.agentSessionId),
    )
    .where(
      and(
        eq(agentSessions.integrationId, session.integrationId),
        eq(agentSessions.externalIssueId, session.externalIssueId),
        eq(agentActivities.kind, "issue_attachment"),
        eq(agentActivities.deliveryStatus, "sent"),
        ne(agentActivities.id, row.id),
      ),
    )
    .limit(1);
  return sent !== undefined;
}

/**
 * The review-state move for an issue's first pull request.
 * @param integration - The integration.
 * @param session - The session.
 * @returns The outcome.
 */
async function moveToReview(
  integration: Integration,
  session: AgentSession,
): Promise<HygieneOutcome> {
  const { issue } = await linearRequest(
    integration,
    GetIssue,
    { id: session.externalIssueId },
    { idempotent: true },
  );
  if (FINISHED_STATE_TYPES.has(issue.state.type))
    return {
      outcome: "unchanged",
      detail: `already ${issue.state.type} (${issue.state.name})`,
    };
  const review = await reviewState(integration, issue.team.id);
  if (!review)
    return { outcome: "skipped", detail: "the team has no review state" };
  if (issue.state.id === review.id)
    return { outcome: "unchanged", detail: `already ${review.name}` };
  await linearRequest(integration, UpdateIssue, {
    id: issue.id,
    input: { stateId: review.id },
  });
  return { outcome: "moved", detail: review.name };
}

/**
 * Send one `issue_attachment` row: link the pull request to the session's
 * issue, then, for the issue's first, run the review-state move. Throws what
 * the link throws, for the outbox to classify (a lost answer, a rate limit);
 * a duplicate id is a resend that landed, and counts as linked.
 * @param integration - The integration to act as.
 * @param session - The session.
 * @param row - The row.
 * @returns The row's content with what happened.
 */
export async function sendIssueAttachment(
  integration: Integration,
  session: AgentSession,
  row: AgentActivity,
): Promise<IssueAttachmentContent> {
  const content = row.content as unknown as IssueAttachmentContent;
  const variables: LinearAttachmentLinkVariables = {
    id: row.clientActivityId,
    issueId: session.externalIssueId,
    url: content.url,
    title: content.title,
  };
  const result: IssueAttachmentContent = {
    url: content.url,
    title: content.title,
  };
  if (isGitHubPullRequest(content.url)) {
    try {
      await linearRequest(integration, AttachmentLinkGitHubPR, variables, {
        idempotent: true,
      });
      result.linkedVia = "github";
    } catch (e) {
      if (!(e instanceof LinearGraphQLError)) throw e;
      if (isDuplicateIdError(e)) result.linkedVia = "github";
      else result.githubRefusal = e.message;
    }
  }
  if (!result.linkedVia) {
    try {
      await linearRequest(integration, AttachmentLinkURL, variables, {
        idempotent: true,
      });
    } catch (e) {
      if (!(e instanceof LinearGraphQLError && isDuplicateIdError(e))) throw e;
    }
    result.linkedVia = "url";
  }

  if (session.role === "manager") {
    result.review = { outcome: "skipped", detail: "manager role" };
  } else if (await issueHadAttachment(session, row)) {
    result.review = {
      outcome: "skipped",
      detail: "not the first pull request",
    };
  } else {
    try {
      result.review = await moveToReview(integration, session);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      result.review = { outcome: "failed", detail };
      api.logger.warn("moving an issue to review failed", {
        agentSessionId: session.id,
        activityId: row.id,
        error: detail,
      });
    }
  }
  return result;
}
