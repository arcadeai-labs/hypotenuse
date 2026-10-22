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
import { register, unregister } from "../shutdown";

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

/** One turn of a session, as `agent-session:view` lists it. */
export interface SessionTurn {
  id: number;
  kind: string;
  role: string | null;
  status: string;
  attempts: number;
  runnerName: string | null;
  waitingCode: string | null;
  waitingReason: string | null;
  cancelReason: string | null;
  createdAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
}

/** What `agent-session:view` says beyond the session and its tree. */
export interface SessionDetail {
  runner?: {
    id: number;
    name: string;
    status: string;
    owner: { id: number; name: string } | null;
  } | null;
  issuer?: {
    name: string | null;
    externalUserId: string | null;
    user: { id: number; name: string } | null;
  } | null;
  workItems?: SessionTurn[];
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
 * @param tree - The manager that dispatched it and the sessions it dispatched,
 *   and its runner, issuer, and turns.
 * @returns Lines for stdout.
 */
export function describeSession(
  session: AgentSession,
  activities: AgentActivity[],
  tree: SessionTree & SessionDetail = {},
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
  if (tree.runner) {
    const owner = tree.runner.owner ? `, ${tree.runner.owner.name}'s` : "";
    lines.push(
      `runner     ${tree.runner.name} (${tree.runner.status}${owner})`,
    );
  }
  if (tree.issuer?.user) {
    lines.push(`issuer     ${tree.issuer.user.name}`);
  }
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
  const turns = tree.workItems ?? [];
  if (turns.length > 0) {
    lines.push("", "Turns", turnsTable(turns));
  }
  if (activities.length > 0) {
    lines.push("", transcriptTable(activities));
  }
  return lines.join("\n");
}

/**
 * A session's turns as a table: what each was, where it ran, and — for one
 * still waiting — the reason code and sentence.
 * @param turns - The turns, oldest first.
 * @returns The table.
 */
export function turnsTable(turns: SessionTurn[]): string {
  return table(
    turns.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      runner: t.runnerName ?? "-",
      claimed: when(t.claimedAt),
      finished: when(t.finishedAt),
      attempts: t.attempts,
      why:
        t.waitingCode !== null
          ? `${t.waitingCode}: ${t.waitingReason ?? ""}`.trim()
          : (t.cancelReason ?? ""),
    })),
    [
      { key: "id" },
      { key: "kind" },
      { key: "status" },
      { key: "runner" },
      { key: "claimed" },
      { key: "finished" },
      { key: "attempts" },
      { key: "why", maxWidth: 60 },
    ],
  );
}

/**
 * Activities as a table, one line each.
 * @param activities - The activities, in order.
 * @returns The table.
 */
export function transcriptTable(activities: AgentActivity[]): string {
  return table(
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
  );
}

/** How often `session view --follow` re-reads, by default. */
const FOLLOW_INTERVAL_SECONDS = 2;

/** A minimal client: what the session commands call. */
interface Requester {
  request<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, unknown> },
  ): Promise<T>;
}

/**
 * Whether a target names an issue (`ENG-123`) rather than a session id.
 * @param target - What the person typed.
 * @returns True for an issue identifier.
 */
export function isIssueIdentifier(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(target.trim());
}

/**
 * Turn a session id or an issue identifier into a session id: an identifier
 * names the newest session on that issue.
 * @param client - The signed-in client.
 * @param projectId - The project.
 * @param target - A session id or an identifier like `ENG-123`.
 * @returns The session id.
 * @throws {Error} When no session is on that issue.
 */
export async function resolveSessionId(
  client: Requester,
  projectId: number,
  target: string,
): Promise<number> {
  if (/^\d+$/.test(target.trim())) return Number(target);
  if (!isIssueIdentifier(target)) {
    throw new Error(
      `"${target}" is neither a session id nor an issue identifier like ENG-123.`,
    );
  }
  const { agentSessions } = await client.request<{
    agentSessions: AgentSession[];
  }>("GET", "/agent-sessions", {
    query: { projectId, issueIdentifier: target.trim(), limit: 1 },
  });
  const newest = agentSessions[0];
  if (!newest) throw new Error(`No session on ${target.toUpperCase()}.`);
  return newest.id;
}

/**
 * Every activity of a session after `afterSeq`, every page.
 * @param client - The signed-in client.
 * @param projectId - The project.
 * @param id - The session.
 * @param afterSeq - Only activities after this sequence number.
 * @returns The activities, in order.
 */
async function readActivities(
  client: Requester,
  projectId: number,
  id: number,
  afterSeq?: number,
): Promise<AgentActivity[]> {
  const activities: AgentActivity[] = [];
  for (let page = 1; ; page++) {
    const result = await client.request<{
      activities: AgentActivity[];
      pagination: Pagination;
    }>("GET", `/agent-session/${id}/activities`, {
      query: { projectId, page, limit: ACTIVITY_PAGE, afterSeq },
    });
    activities.push(...result.activities);
    if (page >= result.pagination.pages) break;
  }
  return activities;
}

/**
 * Re-read new activities every `intervalMs` and hand them on, until the
 * process is interrupted. The pending timer is the only thing holding the
 * process open, and the shutdown registry clears it, so a signal ends the
 * loop and the process exits.
 * @param intervalMs - How long between reads.
 * @param fromSeq - The last sequence number already shown.
 * @param read - Reads activities after a sequence number.
 * @param print - Shows the new ones.
 * @param signal - Ends the loop when aborted (tests; a signal exits anyway).
 * @returns When interrupted or aborted.
 */
export async function follow(
  intervalMs: number,
  fromSeq: number,
  read: (afterSeq: number) => Promise<AgentActivity[]>,
  print: (fresh: AgentActivity[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  let last = fromSeq;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const closer = {
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
  register(closer);
  signal?.addEventListener("abort", () => void closer.close());
  try {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
      timer = null;
      wake = null;
      if (stopped) break;
      const fresh = await read(last);
      if (fresh.length > 0) {
        print(fresh);
        last = fresh.at(-1)!.seq;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    unregister(closer);
  }
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
      )
      .option("--runner <id>", "only sessions held by this runner"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as {
        status?: string;
        role?: string;
        type?: string;
        issue?: string;
        runner?: string;
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
          runnerId: opts.runner,
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
    .command("view <session>")
    .description(
      "Show one session — by id, or the newest on an issue (ENG-123) — with its turns and activities, in order",
    )
    .option("--transcript", "print only the activities")
    .option(
      "--follow",
      "keep printing new activities as they arrive, until interrupted",
    )
    .option(
      "--interval <seconds>",
      "how often --follow re-reads",
      String(FOLLOW_INTERVAL_SECONDS),
    )
    .action(async function (this: Command, target: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          transcript?: boolean;
          follow?: boolean;
          interval: string;
        };
        const projectId = await ctx.projectId();
        const client = ctx.signedInClient();
        const id = await resolveSessionId(client, projectId, target);
        const view = await client.request<
          { agentSession: AgentSession } & SessionTree & SessionDetail
        >("GET", `/agent-session/${id}`, { query: { projectId } });
        const activities = await readActivities(client, projectId, id);
        if (opts.transcript) {
          emit(ctx, { activities }, () =>
            activities.length > 0 ? transcriptTable(activities) : "",
          );
        } else {
          emit(
            ctx,
            {
              ...view,
              parent: view.parent ?? null,
              children: view.children ?? [],
              activities,
            },
            () => describeSession(view.agentSession, activities, view),
          );
        }
        if (!opts.follow) return;
        const intervalMs = Math.max(0.2, Number(opts.interval) || 0) * 1000;
        await follow(
          intervalMs,
          activities.at(-1)?.seq ?? 0,
          (afterSeq) => readActivities(client, projectId, id, afterSeq),
          (fresh) => {
            for (const a of fresh) {
              console.log(
                ctx.json
                  ? JSON.stringify(a)
                  : `${a.seq}  ${when(a.createdAt)}  ${a.direction === "inbound" ? "in " : "out"}  ${a.contentType ?? a.kind}  ${activitySummary(a)}`,
              );
            }
          },
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
