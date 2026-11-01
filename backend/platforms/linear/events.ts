import { createHash } from "node:crypto";
import type { ChannelRef, NormalizedInbound, OpenInstallation } from "../types";

/**
 * **Linear's deliveries, read** — the app webhook's bodies, as the inbound
 * things every rule in `TriggerEventOps` reads. One row per case; anything
 * else is read as a `noted` lifecycle, so its decided outcome is on the
 * Events page.
 *
 * | Delivery | Condition | Becomes |
 * |---|---|---|
 * | `AgentSessionEvent` `created` | — | a message, addressed: the issue, its context, and the person's words; the session's issue, team, and project on the conversation; the acknowledgement asks for issue hygiene when the issue is delegated to the bot |
 * | `AgentSessionEvent` `prompted` | the activity carries the `stop` signal | the `stop` signal, answered with a `response` quoting the person's note |
 * | `AgentSessionEvent` `prompted` | otherwise | a message, addressed (the answer to an elicitation, an option chosen, `Approve #41`) |
 * | `AgentSessionEvent` | any other `action` | `noted: ignored-unknown` |
 * | `AppUserNotification` | `issueUnassignedFromYou` | `disengage` the issue's sessions |
 * | `AppUserNotification` | `issueAssignedToYou` | `noted: assigned-not-delegated` (the bot works by delegation) |
 * | `AppUserNotification` | `issueMention`, `issueCommentMention`, `issueNewComment`, `issueStatusChanged`, reactions, anything else | `noted: notification-<type>`: Linear opens a session itself for a mention; a status change arrives as an `Issue` update too |
 * | `Issue` `update` | the delegate changed away from the bot | `disengage` the issue's sessions |
 * | `Issue` `update` | the state moved to a `completed` or `canceled` type, by someone other than the bot | `disengage` the issue's sessions |
 * | `Issue` `update` | anything else | `noted: issue-update` |
 * | `Issue` `remove` | — | `disengage` the issue's sessions |
 * | `PermissionChange` | — | `settings` (the team access recorded); `disengage` the sessions on teams the app lost |
 * | `OAuthApp` `revoked` | — | `uninstall` |
 *
 * **Channels.** A session's channel — its memory boundary — is the issue's
 * Linear project (`project:<id>`), or its team (`team:<id>`) when the issue
 * has no project. **Conversations** are agent sessions, keyed by session id.
 */

/** The fields of an issue in a session or an `Issue` event this module reads. */
interface LinearIssue {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string;
  description?: string | null;
  teamId?: string;
  team?: { id?: string; key?: string; name?: string } | null;
  projectId?: string | null;
  project?: { id?: string; name?: string } | null;
  delegateId?: string | null;
  stateId?: string;
  state?: { id?: string; type?: string; name?: string } | null;
}

/** A person, as Linear names one in a payload. */
interface LinearUser {
  id?: string;
  name?: string;
  displayName?: string;
}

/** An `AgentSessionEvent` body. */
interface AgentSessionEvent {
  type: "AgentSessionEvent";
  action?: string;
  organizationId?: string;
  appUserId?: string;
  agentSession?: {
    id?: string;
    url?: string;
    creatorId?: string | null;
    creator?: LinearUser | null;
    issueId?: string;
    issue?: LinearIssue | null;
    comment?: { id?: string; body?: string } | null;
  };
  agentActivity?: {
    id?: string;
    userId?: string;
    user?: LinearUser | null;
    signal?: string | null;
    body?: string;
    content?: { type?: string; body?: string };
  };
  promptContext?: string;
  guidance?: { body?: string; content?: string }[] | null;
  createdAt?: string;
}

/** Any other body, as far as this module reads it. */
interface LinearBody {
  type?: string;
  action?: string;
  organizationId?: string;
  appUserId?: string;
  createdAt?: string;
  webhookTimestamp?: number;
  data?: LinearIssue & { id?: string };
  updatedFrom?: Record<string, unknown>;
  actor?: { id?: string; type?: string } | null;
  notification?: {
    id?: string;
    type?: string;
    issueId?: string;
    issue?: LinearIssue | null;
  };
  canAccessAllPublicTeams?: boolean;
  addedTeamIds?: string[];
  removedTeamIds?: string[];
}

/** The Linear "user" every non-message inbound is attributed to. */
const LINEAR = {
  externalUserId: "linear",
  displayName: "Linear",
  isBot: false,
  isSelf: false,
};

/** Linear asks for an answer within five seconds. */
const ACK_DEADLINE_MS = 5_000;

/**
 * The channel an issue belongs to: its project, or its team.
 * @param issue - The issue.
 * @returns The channel reference.
 */
export function issueChannel(
  issue: LinearIssue | null | undefined,
): ChannelRef {
  const projectId = issue?.projectId ?? issue?.project?.id ?? null;
  if (projectId) {
    return {
      externalId: `project:${projectId}`,
      name: issue?.project?.name ?? `Project ${projectId.slice(0, 8)}`,
      isPrivate: false,
      isShared: false,
      isDm: false,
    };
  }
  const teamId = issue?.teamId ?? issue?.team?.id ?? "unknown";
  return {
    externalId: `team:${teamId}`,
    name:
      issue?.team?.name ??
      (issue?.team?.key
        ? `Team ${issue.team.key}`
        : `Team ${teamId.slice(0, 8)}`),
    isPrivate: false,
    isShared: false,
    isDm: false,
  };
}

/** A channel for inbounds about the whole workspace. */
const WORKSPACE: ChannelRef = {
  externalId: "workspace",
  name: "workspace",
  isPrivate: false,
  isShared: false,
  isDm: false,
};

/**
 * A lifecycle inbound.
 * @param key - The dedupe key.
 * @param extra - The lifecycle and its fields.
 * @returns The inbound.
 */
function lifecycle(
  key: string,
  extra: Partial<NormalizedInbound>,
): NormalizedInbound {
  return {
    kind: "lifecycle",
    messageKey: key,
    channel: WORKSPACE,
    conversationKey: "",
    sender: LINEAR,
    addressed: false,
    ackDeadlineMs: ACK_DEADLINE_MS,
    ...extra,
  };
}

/**
 * A decided outcome that changes nothing.
 * @param key - The dedupe key.
 * @param note - The outcome.
 * @returns The inbound.
 */
function noted(key: string, note: string): NormalizedInbound {
  return lifecycle(key, { lifecycle: "noted", note });
}

/**
 * Disengage every session on some issues (or teams).
 * @param key - The dedupe key.
 * @param by - The conversation detail to match.
 * @param values - Its values.
 * @returns The inbound.
 */
function disengage(
  key: string,
  by: "issueId" | "teamId",
  values: string[],
): NormalizedInbound {
  return lifecycle(key, {
    lifecycle: "disengage",
    disengage: { key: by, values },
  });
}

/**
 * The text a person wrote in a prompt: Linear's schema puts it at
 * `content.body`, its docs at `body`.
 * @param a - The activity.
 * @returns The text.
 */
function promptBody(a: AgentSessionEvent["agentActivity"]): string {
  return String(a?.content?.body ?? a?.body ?? "").trim();
}

/**
 * The first message of a session: where it is, what it is about, and what
 * Linear gave as context.
 * @param e - The event.
 * @returns The text.
 */
function openingText(e: AgentSessionEvent): string {
  const issue = e.agentSession?.issue;
  const head = issue
    ? `Linear issue ${issue.identifier ?? issue.id ?? ""}: ${issue.title ?? ""}${issue.url ? ` (${issue.url})` : ""}`
    : "A Linear agent session";
  const parts = [head.trim()];
  const context = (e.promptContext ?? "").trim();
  if (context) parts.push(context);
  const comment = (e.agentSession?.comment?.body ?? "").trim();
  if (comment && !context.includes(comment)) parts.push(comment);
  const guidance = (e.guidance ?? [])
    .map((g) => String(g.body ?? g.content ?? "").trim())
    .filter(Boolean);
  if (guidance.length > 0) {
    parts.push(`Guidance from the workspace:\n${guidance.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Read an `AgentSessionEvent`.
 * @param e - The event.
 * @param inst - The installation.
 * @returns What it says.
 */
function readSessionEvent(
  e: AgentSessionEvent,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const session = e.agentSession;
  const sessionId = session?.id;
  const org = e.organizationId ?? inst.installation.externalWorkspaceId;
  if (!sessionId) return [];
  const issue = session.issue ?? null;
  const channel = issueChannel(issue);
  const issueId = issue?.id ?? session.issueId ?? null;
  const details = {
    issueId,
    issueIdentifier: issue?.identifier ?? null,
    issueUrl: issue?.url ?? null,
    teamId: issue?.teamId ?? issue?.team?.id ?? null,
    projectId: issue?.projectId ?? issue?.project?.id ?? null,
    sessionUrl: session.url ?? null,
  };
  if (e.action === "created") {
    const creator = session.creator;
    const self = inst.installation.externalBotUserId;
    return [
      {
        kind: "message",
        messageKey: `${org}:${sessionId}:created`,
        channel,
        conversationKey: sessionId,
        sender: {
          externalUserId: creator?.id ?? session.creatorId ?? "linear",
          displayName:
            creator?.displayName ?? creator?.name ?? creator?.id ?? "Linear",
          isBot: false,
          isSelf: false,
        },
        addressed: true,
        text: openingText(e),
        conversationDetails: details,
        ackPayload: {
          ...(issueId && self && issue?.delegateId === self
            ? { hygiene: { issueId } }
            : {}),
        },
        ackDeadlineMs: ACK_DEADLINE_MS,
      },
    ];
  }
  if (e.action === "prompted") {
    const activity = e.agentActivity;
    const user = activity?.user;
    const sender = {
      externalUserId: user?.id ?? activity?.userId ?? "linear",
      displayName: user?.displayName ?? user?.name ?? user?.id ?? "Linear",
      isBot: false,
      isSelf:
        inst.installation.externalBotUserId !== null &&
        (user?.id ?? activity?.userId) === inst.installation.externalBotUserId,
    };
    const body = promptBody(activity);
    const key = `${org}:${sessionId}:${activity?.id ?? e.createdAt ?? ""}`;
    if (activity?.signal === "stop") {
      return [
        {
          kind: "signal",
          signal: "stop",
          messageKey: key,
          channel,
          conversationKey: sessionId,
          sender,
          addressed: true,
          reply: body
            ? `Stopped, as asked. Your note, which I have not acted on: “${body.slice(0, 500)}”`
            : "Stopped, as asked.",
          ackDeadlineMs: ACK_DEADLINE_MS,
        },
      ];
    }
    return [
      {
        kind: "message",
        messageKey: key,
        channel,
        conversationKey: sessionId,
        sender,
        addressed: true,
        text: body,
        conversationDetails: details,
        ackDeadlineMs: ACK_DEADLINE_MS,
      },
    ];
  }
  return [
    noted(`${org}:${sessionId}:${e.action ?? "unknown"}`, "ignored-unknown"),
  ];
}

/**
 * Read an `Issue` data-change event: un-delegation, completion, deletion.
 * @param b - The body.
 * @param inst - The installation.
 * @param key - The dedupe key.
 * @returns What it says.
 */
function readIssueEvent(
  b: LinearBody,
  inst: OpenInstallation,
  key: string,
): NormalizedInbound[] {
  const issueId = b.data?.id;
  if (!issueId) return [noted(key, "issue-update")];
  if (b.action === "remove") return [disengage(key, "issueId", [issueId])];
  if (b.action !== "update")
    return [noted(key, `issue-${b.action ?? "event"}`)];
  const self = inst.installation.externalBotUserId;
  const from = b.updatedFrom ?? {};
  if (
    self &&
    "delegateId" in from &&
    from.delegateId === self &&
    b.data?.delegateId !== self
  ) {
    return [disengage(key, "issueId", [issueId])];
  }
  const type = b.data?.state?.type;
  const moved = "stateId" in from || "state" in from;
  if (
    moved &&
    (type === "completed" || type === "canceled") &&
    b.actor?.id !== self
  ) {
    return [disengage(key, "issueId", [issueId])];
  }
  return [noted(key, "issue-update")];
}

/**
 * Read an `AppUserNotification`: none starts work.
 * @param b - The body.
 * @param key - The dedupe key.
 * @returns What it says.
 */
function readNotification(b: LinearBody, key: string): NormalizedInbound[] {
  const type = b.notification?.type ?? b.action ?? "unknown";
  const issueId = b.notification?.issueId ?? b.notification?.issue?.id;
  if (type === "issueUnassignedFromYou" && issueId) {
    return [disengage(key, "issueId", [issueId])];
  }
  if (type === "issueAssignedToYou")
    return [noted(key, "assigned-not-delegated")];
  return [noted(key, `notification-${type}`)];
}

/**
 * **Read a Linear delivery.**
 * @param body - The parsed body.
 * @param inst - The installation.
 * @returns What it says.
 */
export function parseLinearDelivery(
  body: unknown,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const b = (body ?? {}) as LinearBody;
  const org = b.organizationId ?? inst.installation.externalWorkspaceId;
  const key = `${org}:${linearEventId(body, null)}`;
  switch (b.type) {
    case "AgentSessionEvent":
      return readSessionEvent(body as AgentSessionEvent, inst);
    case "Issue":
      return readIssueEvent(b, inst, key);
    case "AppUserNotification":
      return readNotification(b, key);
    case "PermissionChange": {
      const removed = (b.removedTeamIds ?? []).filter(Boolean);
      const previous = (inst.installation.config.teamAccess ?? {}) as {
        teamIds?: string[];
      };
      const teamIds = [
        ...new Set([...(previous.teamIds ?? []), ...(b.addedTeamIds ?? [])]),
      ].filter((t) => !removed.includes(t));
      const out: NormalizedInbound[] = [
        lifecycle(`${key}:settings`, {
          lifecycle: "settings",
          settings: {
            teamAccess: {
              canAccessAllPublicTeams: b.canAccessAllPublicTeams === true,
              teamIds,
            },
          },
        }),
      ];
      if (removed.length > 0) out.push(disengage(key, "teamId", removed));
      return out;
    }
    case "OAuthApp":
      if (b.action === "revoked") {
        return [lifecycle(key, { lifecycle: "uninstall" })];
      }
      return [noted(key, `oauth-app-${b.action ?? "event"}`)];
    default:
      return [noted(key, `ignored-${b.type ?? "unknown"}`)];
  }
}

/**
 * The id a retry of a delivery repeats: the `Linear-Delivery` header, or —
 * without one — a hash of what the event is about, never of the body (whose
 * `webhookTimestamp` changes on every attempt).
 * @param body - The parsed body.
 * @param headers - The request's headers, when there are any.
 * @returns The id.
 */
export function linearEventId(body: unknown, headers: Headers | null): string {
  const delivery = headers?.get("linear-delivery");
  if (delivery) return delivery;
  const b = (body ?? {}) as LinearBody & Omit<AgentSessionEvent, "type">;
  const about = [
    b.type,
    b.action,
    b.organizationId,
    b.agentActivity?.id ??
      b.agentSession?.id ??
      b.data?.id ??
      b.notification?.id,
    b.createdAt,
    b.type === "PermissionChange"
      ? JSON.stringify([b.addedTeamIds, b.removedTeamIds])
      : "",
  ].join("|");
  return `sha256:${createHash("sha256").update(about).digest("hex").slice(0, 32)}`;
}
