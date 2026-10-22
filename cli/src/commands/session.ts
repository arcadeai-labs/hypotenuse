/**
 * `hypotenuse session` — the selected project's agent sessions, from every
 * trigger type (Linear today)
 * (`agent-session:list`, `agent-session:view`, `agent-session:activities`,
 * `agent-session:cancel`): every time `@hypotenuse` was delegated an issue or
 * mentioned, the conversation that followed, and stopping its work.
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
  /** The manager session that dispatched this one, if any. */
  parentAgentSessionId?: number | null;
  /** How it was dispatched: `new`, `changes`, or null when no manager did. */
  dispatchMode?: "new" | "changes" | null;
  /** How many times its manager has sent it back for changes. */
  reviewRound?: number;
  createdAt: number;
  endedAt: number | null;
}

/** The manager session that dispatched a session, as `agent-session:view` summarizes it. */
export interface ParentSession {
  id: number;
  issueIdentifier: string | null;
  issueUrl: string | null;
  status: string;
  role: "manager" | "worker" | null;
}

/** A session a manager dispatched, as `agent-session:view` summarizes it. */
export interface ChildSession {
  id: number;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  status: string;
  dispatchMode: "new" | "changes" | null;
  reviewRound: number;
  pullRequests: { label: string; url: string }[];
  /** The latest turn's status, or null. */
  workStatus: string | null;
}

/** The dispatch tree around a session, as the server decides it. */
export interface SessionTree {
  parent?: ParentSession | null;
  children?: ChildSession[];
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
 * @param tree - The manager that dispatched it and the sessions it dispatched.
 * @returns Lines for stdout.
 */
export function describeSession(
  session: AgentSession,
  activities: AgentActivity[],
  tree: SessionTree = {},
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
  const parent = tree.parent;
  if (parent) {
    // `reviewRound` counts change requests; a person reads round 1 first.
    const round = `, round ${(session.reviewRound ?? 0) + 1}`;
    lines.push(
      `dispatched by session ${parent.id} on ${parent.issueIdentifier ?? "-"} (${parent.status}${round})${parent.issueUrl ? ` ${parent.issueUrl}` : ""}`,
    );
  }
  const children = tree.children ?? [];
  if (children.length > 0) {
    lines.push(
      "",
      "Dispatched",
      table(
        children.map((c) => ({
          id: c.id,
          issue: c.issueIdentifier ?? "-",
          title: c.issueTitle ?? "",
          status: c.status,
          turn: c.workStatus ?? "-",
          round: c.reviewRound + 1,
          "pull requests": c.pullRequests.map((p) => p.url).join(" ") || "-",
        })),
        [
          { key: "id" },
          { key: "issue" },
          { key: "title", maxWidth: 30 },
          { key: "status" },
          { key: "turn" },
          { key: "round" },
          { key: "pull requests", maxWidth: 60 },
        ],
      ),
    );
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
 * Register `session list`, `session view`, and `session cancel`.
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
        const { agentSession, parent, children } = await client.request<
          { agentSession: AgentSession } & SessionTree
        >("GET", `/agent-session/${encodeURIComponent(id)}`, {
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
        emit(
          ctx,
          {
            agentSession,
            parent: parent ?? null,
            children: children ?? [],
            activities,
          },
          () => describeSession(agentSession, activities, { parent, children }),
        );
      });
    });

  session
    .command("cancel <id>")
    .description(
      "Stop a session's work, as Stop in Linear does: work not started is cancelled; a running turn is told to stop and report",
    )
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          agentSession: AgentSession;
        }>("POST", `/agent-session/${encodeURIComponent(id)}/cancel`, {
          body: { projectId },
        });
        const s = result.agentSession;
        emit(
          ctx,
          result,
          () =>
            `Asked session #${s.id} (${s.issueIdentifier ?? s.externalSessionId}) to stop. Linear shows what it was left doing.`,
        );
      });
    });
}
