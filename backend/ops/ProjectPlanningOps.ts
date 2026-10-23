import { eq } from "drizzle-orm";
import { api } from "keryx";
import { type AgentSession, agentSessions } from "../schema/agent_sessions";
import type { Integration } from "../schema/integrations";
import type { TriggerEvent } from "../schema/trigger_events";
import { takeLinearToken } from "./LinearBucketOps";
import { LinearGraphQLError, linearRequest } from "./LinearOps";
import {
  CreateAgentSessionOnIssue,
  CreateComment,
  CreateIssue,
  GetProjectDetail,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";

/**
 * Planning a Linear project from a mention on it.
 *
 * Linear starts no agent session for a mention in a project comment, and
 * refuses one there (`agentSessionCreateOnComment`: "comment must be on an
 * issue"). So a person's `projectCommentMention` files a planning issue in
 * the project — `[hypotenuse] Plan: <project>` — starts a session on it, and
 * replies on the comment with a link. The session is a **manager**, whatever
 * the routing rules say, with the comment's text as its instruction: a
 * Redis **intent** keyed by the issue says so, and the `created` webhook
 * applies it (`adoptPlanningSession`), as a dispatch's intent does.
 *
 * Every Linear call here is made by the `triggers:check-notifications` clock,
 * outside any transaction. The filed issue is remembered per notification,
 * so a retry after a lost response files no second one.
 */

/** How long a planning intent waits for Linear's `created`. */
export const PLANNING_INTENT_TTL_SECONDS = 10 * 60;

/** How long the issue a notification filed is remembered, for retries. */
const PLANNING_ISSUE_TTL_SECONDS = 2 * 60 * 60;

/** The prefix of every planning issue's title. */
export const PLANNING_TITLE_PREFIX = "[hypotenuse] Plan: ";

/** The routing-rule name a planning session records for its role. */
export const PLANNING_RULE_NAME = "project mention";

/** What the `created` webhook applies to a planning session. */
export interface PlanningIntent {
  /** The comment's text, without the mention or a role prefix. */
  instruction: string | null;
  /** Who mentioned the app, so their runners are preferred. */
  creatorExternalUserId: string | null;
  creatorName: string | null;
  creatorEmail: string | null;
}

/** The fields of a `projectCommentMention` read here. */
interface ProjectMention {
  commentId: string;
  body: string;
  projectId: string;
  projectName: string;
  projectUrl: string | null;
  actor: { id: string | null; name: string | null; email: string | null };
}

/** The planning issue, as remembered between attempts. */
interface FiledIssue {
  id: string;
  identifier: string;
  url: string;
}

/** What one attempt decided. */
export type PlanningResult =
  | { kind: "started"; summary: string }
  | { kind: "refused"; summary: string }
  | { kind: "retry"; error: string };

/**
 * The intent key for an issue.
 * @param integrationId - The integration.
 * @param externalIssueId - The planning issue's Linear id.
 * @returns The Redis key.
 */
export function planningIntentKey(
  integrationId: number,
  externalIssueId: string,
): string {
  return `planning:intent:${integrationId}:${externalIssueId}`;
}

/**
 * The key remembering the issue a notification filed.
 * @param eventId - The notification's `trigger_events` row.
 * @returns The Redis key.
 */
export function planningIssueKey(eventId: number): string {
  return `planning:issue:${eventId}`;
}

/**
 * Read the mention from a `projectCommentMention` payload.
 * @param payload - The delivery's body.
 * @returns The mention, or null when a field it needs is missing.
 */
export function projectMention(
  payload: Record<string, unknown>,
): ProjectMention | null {
  const n = (payload.notification ?? {}) as {
    commentId?: unknown;
    comment?: { id?: unknown; body?: unknown } | null;
    projectId?: unknown;
    project?: { id?: unknown; name?: unknown; url?: unknown } | null;
    actorId?: unknown;
    actor?: { id?: unknown; name?: unknown; email?: unknown } | null;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const commentId = str(n.commentId) ?? str(n.comment?.id);
  const projectId = str(n.projectId) ?? str(n.project?.id);
  if (!commentId || !projectId) return null;
  return {
    commentId,
    body: str(n.comment?.body) ?? "",
    projectId,
    projectName: str(n.project?.name) ?? "the project",
    projectUrl: str(n.project?.url),
    actor: {
      id: str(n.actorId) ?? str(n.actor?.id),
      name: str(n.actor?.name),
      email: str(n.actor?.email),
    },
  };
}

/**
 * A mention's text without its leading mentions or a role prefix:
 * `@hypotenuse /manage plan the launch` → `plan the launch`.
 * @param body - The comment's Markdown.
 * @returns The instruction, or null when nothing is left.
 */
export function planningInstruction(body: string): string | null {
  const text = body
    .replace(/^\s*(?:\[?@[^\s\]]+\]?(?:\([^)]*\))?\s*)+/, "")
    .replace(/^\/[a-z]+\b\s*/i, "")
    .trim();
  return text || null;
}

/**
 * The planning issue's description: what was asked, and where.
 * @param mention - The mention.
 * @param instruction - Its text, if any.
 * @returns Markdown.
 */
function issueDescription(
  mention: ProjectMention,
  instruction: string | null,
): string {
  const who = mention.actor.name ?? "Someone";
  const where = mention.projectUrl
    ? `[${mention.projectName}](${mention.projectUrl})`
    : mention.projectName;
  return [
    instruction ?? "Plan this project.",
    "---",
    `${who} asked @hypotenuse to plan ${where} in a comment on the project. The planning agent works from this issue: reply in its session to steer it.`,
  ].join("\n\n");
}

/**
 * Spend one token of the integration's Linear budget.
 * @param integration - The integration.
 */
async function spend(integration: Integration): Promise<void> {
  const take = await takeLinearToken(integration.id, "normal");
  if (!take.granted) throw new Error("the request budget is spent");
}

/**
 * File the planning issue, start a manager session on it, and reply on the
 * comment. Safe to retry: the issue is filed once per notification.
 * @param event - The claimed notification.
 * @param integration - Its integration.
 * @returns Started, refused (with Linear's message), or retry.
 */
export async function startProjectPlanning(
  event: TriggerEvent,
  integration: Integration,
): Promise<PlanningResult> {
  const mention = projectMention(event.payload);
  if (!mention) {
    return {
      kind: "refused",
      summary: "The project mention names no comment or project.",
    };
  }
  const instruction = planningInstruction(mention.body);
  const redis = api.redis.redis;
  try {
    let issue: FiledIssue | null = null;
    const remembered = await redis.get(planningIssueKey(event.id));
    if (remembered) issue = JSON.parse(remembered) as FiledIssue;
    if (!issue) {
      await spend(integration);
      const { project } = await linearRequest(integration, GetProjectDetail, {
        id: mention.projectId,
      });
      const teams = project.teams.nodes;
      const team = teams.find((t) => !t.private) ?? teams[0];
      if (!team) {
        return {
          kind: "refused",
          summary: `${project.name} has no team to file a planning issue in.`,
        };
      }
      await spend(integration);
      const { issueCreate } = await linearRequest(integration, CreateIssue, {
        input: {
          teamId: team.id,
          projectId: project.id,
          title: `${PLANNING_TITLE_PREFIX}${project.name}`,
          description: issueDescription(
            { ...mention, projectName: project.name, projectUrl: project.url },
            instruction,
          ),
        },
      });
      issue = {
        id: issueCreate.issue.id,
        identifier: issueCreate.issue.identifier,
        url: issueCreate.issue.url,
      };
      await redis.set(
        planningIssueKey(event.id),
        JSON.stringify(issue),
        "EX",
        PLANNING_ISSUE_TTL_SECONDS,
      );
    }

    const intent: PlanningIntent = {
      instruction,
      creatorExternalUserId: mention.actor.id,
      creatorName: mention.actor.name,
      creatorEmail: mention.actor.email,
    };
    // Written before the session exists: Linear's `created` may arrive
    // before the mutation answers.
    await redis.set(
      planningIntentKey(integration.id, issue.id),
      JSON.stringify(intent),
      "EX",
      PLANNING_INTENT_TTL_SECONDS,
    );
    await spend(integration);
    const { agentSessionCreateOnIssue: created } = await linearRequest(
      integration,
      CreateAgentSessionOnIssue,
      { input: { issueId: issue.id } },
    );
    if (!created.success) {
      await redis.del(planningIntentKey(integration.id, issue.id));
      return {
        kind: "refused",
        summary: `Filed ${issue.identifier}, but Linear refused a session on it: it answered success: false.`,
      };
    }

    let replied = true;
    try {
      await spend(integration);
      await linearRequest(integration, CreateComment, {
        input: {
          projectId: mention.projectId,
          parentId: mention.commentId,
          body: `Planning this project in [${issue.identifier}](${issue.url}). Reply there to steer it.`,
        },
      });
    } catch (e) {
      replied = false;
      api.logger.warn("replying on a project comment failed", {
        eventId: event.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      kind: "started",
      summary: `Filed ${issue.identifier} and started a manager session on it${replied ? "; replied on the project comment with the link" : "; the reply on the project comment failed"}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof LinearGraphQLError) {
      return {
        kind: "refused",
        summary: `Linear refused planning the project: ${message}`,
      };
    }
    return { kind: "retry", error: message };
  }
}

/**
 * Make a session Hypotenuse started for a project mention a manager, with
 * the comment's text and author, if its issue has a planning intent; the
 * intent is used once. Called by the `created` webhook before the first turn
 * is queued, so routing finds the role set and decides no other.
 * @param tx - The transaction.
 * @param integrationId - The integration.
 * @param session - The session, as just mirrored.
 * @returns The session, updated when it was a planning session.
 */
export async function adoptPlanningSession(
  tx: TxHandle,
  integrationId: number,
  session: AgentSession,
): Promise<AgentSession> {
  if (!session.externalIssueId || session.role !== null) return session;
  const key = planningIntentKey(integrationId, session.externalIssueId);
  const raw = await api.redis.redis.getdel(key);
  if (!raw) return session;
  const intent = JSON.parse(raw) as PlanningIntent;
  const [updated] = await tx
    .update(agentSessions)
    .set({
      role: "manager",
      routingRuleName: PLANNING_RULE_NAME,
      instruction: intent.instruction,
      ...(session.creatorExternalUserId
        ? {}
        : {
            creatorExternalUserId: intent.creatorExternalUserId,
            creatorName: intent.creatorName,
            creatorEmail: intent.creatorEmail,
          }),
    })
    .where(eq(agentSessions.id, session.id))
    .returning();
  return updated ?? session;
}
