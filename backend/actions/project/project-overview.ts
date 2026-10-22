import { sql } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { getIntegration } from "../../ops/IntegrationOps";
import { recentDeliveries } from "../../ops/TriggerEventOps";
import { AGENT_SESSION_STATUSES } from "../../schema/agent_sessions";
import type { WaitingCode } from "../../schema/work_items";

/** The windows the project home counts over. */
export const OVERVIEW_WINDOWS = { "24h": 86_400_000, "7d": 604_800_000 };

/**
 * `project:overview` — everything the project home shows, in one read:
 *
 * | Card | What |
 * |---|---|
 * | `linear` | connected workspace, status, last webhook received, failed deliveries in the window |
 * | `runners` | online / draining / offline counts, slots used / total over online and draining runners, the oldest live heartbeat |
 * | `sessions` | sessions started in the window by status and role; median time to the acknowledgement and to the first claim |
 * | `queue` | turns queued or offered now, each with why it waits and how long; turns expired in the window |
 *
 * Every number is the server's, so two dashboards never disagree. Requires
 * membership.
 */
export class ProjectOverview implements Action {
  name = "project:overview";
  description =
    "Summarize a project for its home page: whether Linear is connected and receiving webhooks, how many runners are online and how busy, the agent sessions started in the window by status and role with median acknowledgement and claim times, and the work queued right now with why it waits. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/overview", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to summarize"),
    window: z
      .enum(["24h", "7d"])
      .default("24h")
      .describe("How far back to count sessions and failures: 24h or 7d"),
  });

  /**
   * @param params - The project and window.
   * @returns The four cards.
   */
  async run(params: ActionParams<ProjectOverview>) {
    const now = Date.now();
    const since = new Date(now - OVERVIEW_WINDOWS[params.window]);
    const projectId = params.projectId;
    const db = api.db.db;

    const integration = await getIntegration(projectId, "linear");
    let linear = null;
    if (integration) {
      const deliveries = await recentDeliveries(integration.id, 1);
      const [failed] = (
        await db.execute<{ failed: number }>(sql`
          SELECT count(*)::int AS failed FROM trigger_events
          WHERE integration_id = ${integration.id}
            AND outcome = 'failed' AND received_at >= ${since}`)
      ).rows;
      linear = {
        status: integration.status,
        workspaceName: integration.workspaceName,
        workspaceUrlKey: integration.workspaceUrlKey,
        appUserName: integration.appUserName,
        lastWebhookAt: deliveries.lastReceivedAt,
        failedDeliveries: Number(failed?.failed ?? 0),
      };
    }

    const [fleet] = (
      await db.execute<{
        online: number;
        draining: number;
        offline: number;
        used: number;
        total: number;
        oldest: Date | string | null;
      }>(sql`
        SELECT
          count(*) FILTER (WHERE r.status = 'online')::int AS online,
          count(*) FILTER (WHERE r.status = 'draining')::int AS draining,
          count(*) FILTER (WHERE r.status = 'offline')::int AS offline,
          coalesce(sum((SELECT count(*) FROM work_items w
            WHERE w.runner_id = r.id AND w.status IN ('claimed', 'running')))
            FILTER (WHERE r.status IN ('online', 'draining')), 0)::int AS used,
          -- The same runners as used, so the fraction never passes one: a
          -- paused or draining runner still holds its slots until its work ends.
          coalesce(sum((r.limits->>'maxParallelJobs')::int)
            FILTER (WHERE r.status IN ('online', 'draining')), 0)::int AS total,
          min(r.last_heartbeat_at) FILTER (WHERE r.status IN ('online', 'draining')) AS oldest
        FROM runners r
        WHERE r.project_id = ${projectId} AND r.status <> 'revoked'`)
    ).rows;

    const counts = (
      await db.execute<{ status: string; role: string | null; n: number }>(sql`
        SELECT status, role, count(*)::int AS n FROM agent_sessions
        WHERE project_id = ${projectId} AND created_at >= ${since}
        GROUP BY status, role`)
    ).rows;
    const byStatus = Object.fromEntries(
      AGENT_SESSION_STATUSES.map((s) => [s, 0]),
    ) as Record<(typeof AGENT_SESSION_STATUSES)[number], number>;
    const byRole = { manager: 0, worker: 0, undecided: 0 };
    for (const c of counts) {
      if (c.status in byStatus) {
        byStatus[c.status as keyof typeof byStatus] += Number(c.n);
      }
      byRole[(c.role ?? "undecided") as keyof typeof byRole] += Number(c.n);
    }
    const [timing] = (
      await db.execute<{ ack_ms: number | null; claim_ms: number | null }>(sql`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ack.ms) AS ack_ms,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY claim.ms) AS claim_ms
        FROM agent_sessions s
        LEFT JOIN LATERAL (
          SELECT extract(epoch FROM (min(a.sent_at) - s.created_at)) * 1000 AS ms
          FROM agent_activities a
          WHERE a.agent_session_id = s.id AND a.direction = 'outbound' AND a.sent_at IS NOT NULL
        ) ack ON TRUE
        LEFT JOIN LATERAL (
          SELECT extract(epoch FROM (min(w.claimed_at) - s.created_at)) * 1000 AS ms
          FROM work_items w WHERE w.agent_session_id = s.id AND w.claimed_at IS NOT NULL
        ) claim ON TRUE
        WHERE s.project_id = ${projectId} AND s.created_at >= ${since}`)
    ).rows;

    const queued = (
      await db.execute<{
        id: number;
        agent_session_id: number;
        issue_identifier: string | null;
        kind: string;
        role: string | null;
        status: string;
        waiting_code: WaitingCode | null;
        waiting_reason: string | null;
        queued_at: Date | string;
      }>(sql`
        SELECT w.id, w.agent_session_id, s.issue_identifier, w.kind, w.role,
          w.status, w.waiting_code, w.waiting_reason, w.queued_at
        FROM work_items w JOIN agent_sessions s ON s.id = w.agent_session_id
        WHERE w.project_id = ${projectId} AND w.status IN ('queued', 'offered')
        ORDER BY w.queued_at, w.id
        LIMIT 50`)
    ).rows;
    const [expired] = (
      await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM work_items
        WHERE project_id = ${projectId} AND status = 'expired'
          AND finished_at >= ${since}`)
    ).rows;

    // Clamped at zero: a session row written after its first activity
    // (clock skew between processes) must not show a negative wait.
    const ms = (v: number | string | null | undefined) =>
      v === null || v === undefined ? null : Math.max(0, Math.round(Number(v)));
    return {
      overview: {
        window: params.window,
        since: since.getTime(),
        linear,
        runners: {
          online: Number(fleet?.online ?? 0),
          draining: Number(fleet?.draining ?? 0),
          offline: Number(fleet?.offline ?? 0),
          used: Number(fleet?.used ?? 0),
          total: Number(fleet?.total ?? 0),
          oldestHeartbeatAt: fleet?.oldest
            ? new Date(fleet.oldest).getTime()
            : null,
        },
        sessions: {
          total: counts.reduce((n, c) => n + Number(c.n), 0),
          byStatus,
          byRole,
          medianAckMs: ms(timing?.ack_ms),
          medianClaimMs: ms(timing?.claim_ms),
        },
        queue: {
          items: queued.map((q) => ({
            workItemId: Number(q.id),
            agentSessionId: Number(q.agent_session_id),
            issueIdentifier: q.issue_identifier,
            kind: q.kind,
            role: q.role,
            status: q.status,
            waitingCode: q.waiting_code,
            waitingReason: q.waiting_reason,
            ageMs: Math.max(0, now - new Date(q.queued_at).getTime()),
          })),
          expired: Number(expired?.n ?? 0),
        },
      },
    };
  }
}
