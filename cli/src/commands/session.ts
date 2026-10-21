/**
 * `hypotenuse session` — the selected project's agent sessions, from every
 * trigger type (Linear today)
 * (`agent-session:list`, `agent-session:view`, `agent-session:activities`):
 * every time `@hypotenuse` was delegated an issue or mentioned, and the
 * conversation that followed.
 */
import type { Command } from "commander";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** A session as `agent-session:list` and `agent-session:view` serialize it. */
export interface AgentSession {
  id: number;
  /** The trigger type: `linear`. */
  type: string;
  externalSessionId: string;
  externalUrl: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  creatorName: string | null;
  origin: "delegation" | "mention" | "proactive";
  role: "manager" | "worker" | null;
  repository: string | null;
  runnerId: number | null;
  status: string;
  summary: string | null;
  externalUrls: { label: string; url: string }[];
  createdAt: number;
  endedAt: number | null;
}

/** An activity as `agent-session:activities` serializes it. */
export interface AgentActivity {
  seq: number;
  direction: "inbound" | "outbound";
  kind: "activity" | "session_update";
  contentType: string | null;
  content: Record<string, unknown>;
  ephemeral: boolean;
  signal: string | null;
  deliveryStatus: string;
  lastError: string | null;
  createdAt: number;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/** The most activities one `view` request asks for. */
const ACTIVITY_PAGE = 100;

/**
 * One line saying what an activity was: its body, an action and its
 * parameter, or the fields a session update set — newlines folded.
 * @param activity - The activity.
 * @returns The line.
 */
export function activitySummary(activity: AgentActivity): string {
  const c = activity.content;
  let text: string;
  if (activity.kind === "session_update") {
    text = `update ${Object.keys(c).join(", ")}`;
  } else if (activity.contentType === "action") {
    text = [c.action, c.parameter].filter(Boolean).join(" ");
  } else {
    text = typeof c.body === "string" ? c.body : "";
  }
  const signal = activity.signal ? `[${activity.signal}] ` : "";
  return `${signal}${text}`.replace(/\s+/g, " ").trim();
}

/**
 * The human rendering of one session and its conversation.
 * @param session - The session.
 * @param activities - Its activities, in order.
 * @returns Lines for stdout.
 */
export function describeSession(
  session: AgentSession,
  activities: AgentActivity[],
): string {
  const lines = [
    `${session.issueIdentifier ?? "-"}  ${session.issueTitle ?? ""}`.trim(),
    `status     ${session.status}`,
    `origin     ${session.origin}${session.creatorName ? ` by ${session.creatorName}` : ""}`,
    `role       ${session.role ?? "-"}`,
    `repository ${session.repository ?? "-"}`,
    `started    ${when(session.createdAt)}`,
    `ended      ${when(session.endedAt)}`,
  ];
  if (session.summary) lines.push(`summary    ${session.summary}`);
  if (session.externalUrl)
    lines.push(`${session.type.padEnd(10)} ${session.externalUrl}`);
  for (const link of session.externalUrls) {
    lines.push(`link       ${link.label}: ${link.url}`);
  }
  if (activities.length > 0) {
    lines.push(
      "",
      table(
        activities.map((a) => ({
          seq: a.seq,
          when: when(a.createdAt),
          dir: a.direction === "inbound" ? "in" : "out",
          type: a.contentType ?? a.kind,
          delivery: a.deliveryStatus,
          content: activitySummary(a),
        })),
        [
          { key: "seq" },
          { key: "when" },
          { key: "dir" },
          { key: "type" },
          { key: "delivery" },
          { key: "content", maxWidth: 70 },
        ],
      ),
    );
  }
  return lines.join("\n");
}

/**
 * Register `session list` and `session view`.
 * @param program - The root program.
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description(
      "The selected project's agent sessions (each delegation or mention of @hypotenuse)",
    );

  withPaging(
    session
      .command("list")
      .description("List agent sessions, newest first")
      .option(
        "--status <status>",
        "only this status: pending, active, awaitingInput, error, complete, stale, stopping",
      )
      .option("--role <role>", "only this role: manager or worker")
      .option("--type <type>", "only this trigger type, e.g. linear")
      .option(
        "--issue <identifier>",
        "only sessions on this issue, e.g. ENG-123",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as {
        status?: string;
        role?: string;
        type?: string;
        issue?: string;
      };
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        agentSessions: AgentSession[];
        pagination: Pagination;
      }>("GET", "/agent-sessions", {
        query: {
          projectId,
          status: opts.status,
          role: opts.role,
          type: opts.type,
          issueIdentifier: opts.issue,
          ...pageQuery(this),
        },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.agentSessions.map((s) => ({
              id: s.id,
              type: s.type,
              issue: s.issueIdentifier ?? "-",
              title: s.issueTitle ?? "",
              status: s.status,
              origin: s.origin,
              role: s.role ?? "-",
              started: when(s.createdAt),
            })),
            [
              { key: "id" },
              { key: "type" },
              { key: "issue" },
              { key: "title", maxWidth: 40 },
              { key: "status" },
              { key: "origin" },
              { key: "role" },
              { key: "started" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  session
    .command("view <id>")
    .description("Show one session and its activities, in order")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const client = ctx.signedInClient();
        const { agentSession } = await client.request<{
          agentSession: AgentSession;
        }>("GET", `/agent-session/${encodeURIComponent(id)}`, {
          query: { projectId },
        });
        const activities: AgentActivity[] = [];
        for (let page = 1; ; page++) {
          const result = await client.request<{
            activities: AgentActivity[];
            pagination: Pagination;
          }>("GET", `/agent-session/${encodeURIComponent(id)}/activities`, {
            query: { projectId, page, limit: ACTIVITY_PAGE },
          });
          activities.push(...result.activities);
          if (page >= result.pagination.pages) break;
        }
        emit(ctx, { agentSession, activities }, () =>
          describeSession(agentSession, activities),
        );
      });
    });
}
